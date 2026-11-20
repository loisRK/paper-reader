import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateConnections, buildConnectionsPrompt, digestCore, editConnectionItem, deleteConnectionItem, readConnectionsFile,
  MAX_ITEMS, MAX_TEXT, CONNECTIONS_ATTEMPTS,
} from '../src/agent/connections.mjs';
import { createDigestJobs } from '../src/agent/digest-job.mjs';
import { fullDigest } from './fixtures/digest-fixture.mjs';

const SOURCE = {
  id: 'p1',
  meta: { title: 'T' },
  pages: [{ page: 1 }],
  blocks: [{ type: 'paragraph', page: 1, sentenceIds: ['p1-s1', 'p1-s2'] }],
  sentences: { 'p1-s1': { text: 'GPU 스케줄링을 다룬다.', page: 1 }, 'p1-s2': { text: 'b', page: 1 } },
};
const HEADINGS = ['연구 주제', '축 A: GPU 스케줄링', '축 B'];
const item = (o = {}) => ({ target: '축 A: GPU 스케줄링', text: '논문은 GPU 스케줄링을 다룬다고 밝힌다.', evidence: ['p1-s1'], ...o });
const good = (items = [item()]) => ({ version: 1, paperId: 'p1', items });

// ---- validation ----

test('validateConnections: a good file passes; items get server ids; extra fields dropped', () => {
  const { connections, problems } = validateConnections(good([item({ id: 'x', junk: 1 }), item({ target: '축 B', evidence: ['p1-s1', 'p1-s2'] })]), SOURCE, HEADINGS);
  assert.deepEqual(problems, []);
  assert.deepEqual(connections.items, [
    { id: 'k1', target: '축 A: GPU 스케줄링', text: '논문은 GPU 스케줄링을 다룬다고 밝힌다.', evidence: ['p1-s1'] },
    { id: 'k2', target: '축 B', text: '논문은 GPU 스케줄링을 다룬다고 밝힌다.', evidence: ['p1-s1', 'p1-s2'] },
  ]);
  assert.equal(connections.paperId, 'p1');
  assert.equal(connections.version, 1);
});

test('validateConnections: empty items is allowed (nothing relates)', () => {
  const { connections, problems } = validateConnections(good([]), SOURCE, HEADINGS);
  assert.deepEqual(problems, []);
  assert.deepEqual(connections.items, []);
});

test('validateConnections: unknown heading, bad evidence, too long, empty text are problems', () => {
  const { connections, problems } = validateConnections(good([
    item({ target: '없는 제목' }),
    item({ evidence: ['p9-s9'] }),
    item({ evidence: [] }),
    item({ text: 'x'.repeat(MAX_TEXT + 1) }),
    item({ text: '  ' }),
    item(),
  ]), SOURCE, HEADINGS);
  assert.equal(MAX_TEXT, 300);
  assert.ok(problems.some((p) => p.includes('1번') && p.includes('연구 노트에 없는 제목') && p.includes('없는 제목')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('2번') && p.includes('p9-s9')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('3번') && p.includes('근거')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('4번') && p.includes('300자')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('5번') && p.includes('설명')), problems.join('\n'));
  assert.equal(problems.length, 5);
  assert.equal(connections.items.length, 1);
});

test('validateConnections: too many items, missing items, wrong paperId, not an object', () => {
  assert.equal(MAX_ITEMS, 8);
  const many = validateConnections(good(Array.from({ length: 9 }, () => item())), SOURCE, HEADINGS);
  assert.ok(many.problems.some((p) => p.includes('최대 8개')), many.problems.join('\n'));
  assert.ok(validateConnections({ version: 1, paperId: 'p1' }, SOURCE, HEADINGS).problems.some((p) => p.includes('items')));
  assert.ok(validateConnections({ ...good(), paperId: 'other' }, SOURCE, HEADINGS).problems.some((p) => p.includes('paperId')));
  assert.ok(validateConnections(null, SOURCE, HEADINGS).problems.length > 0);
  assert.ok(validateConnections([], SOURCE, HEADINGS).problems.length > 0);
});

test('validateConnections: target with leading #s or surrounding spaces is matched to the heading text', () => {
  const { connections, problems } = validateConnections(good([item({ target: '## 축 B ' })]), SOURCE, HEADINGS);
  assert.deepEqual(problems, []);
  assert.equal(connections.items[0].target, '축 B');
});

// ---- prompt and digest context ----

test('buildConnectionsPrompt: data-not-instructions rule; problems only on a retry', () => {
  const first = buildConnectionsPrompt({ attempt: 1, problems: ['x'] });
  assert.match(first, /connections\.json/);
  assert.match(first, /데이터/);
  assert.doesNotMatch(first, /검증 문제/);
  const second = buildConnectionsPrompt({ attempt: 2, problems: ['1번 항목: 연구 노트에 없는 제목입니다 – 없는 제목'] });
  assert.match(second, /검증 문제/);
  assert.match(second, /- 1번 항목: 연구 노트에 없는 제목입니다 – 없는 제목/);
});

test('digestCore: takeaway and each card question/answer only (no claims); null digest is a short note', () => {
  const d = fullDigest({ paperId: 'p1', cards: 9 });
  d.takeaway.text = '핵심 문장';
  d.cards[0].question = '질문1';
  d.cards[0].answer = '답1';
  d.cards[0].items[0].text = 'CLAIM-TEXT';
  const md = digestCore(d);
  assert.match(md, /핵심 문장/);
  assert.match(md, /질문1/);
  assert.match(md, /답1/);
  assert.doesNotMatch(md, /CLAIM-TEXT/);
  assert.match(digestCore(null), /요약이 아직 없습니다/);
});

test('prompts/connections.md exists and states the rules', async () => {
  const rules = await fs.readFile(new URL('../prompts/connections.md', import.meta.url), 'utf8');
  for (const s of ['connections.json', 'research.md', 'paper.txt', 'digest-core.md', '"items": []', '1~8', '300자']) assert.ok(rules.includes(s), s);
  assert.match(rules, /지시.*따르지 않는다/);
  assert.match(rules, /과장/);
});

// ---- edit / delete ----

async function outWith(t, connections) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-conn-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmp, 'p1'));
  if (connections !== undefined) await fs.writeFile(path.join(tmp, 'p1', 'connections.json'), typeof connections === 'string' ? connections : JSON.stringify(connections));
  return tmp;
}
const STORED = { version: 1, paperId: 'p1', researchNote: 'Notes/r.md', items: [{ id: 'k1', target: '축 B', text: 'a', evidence: ['p1-s1'] }, { id: 'k2', target: '축 B', text: 'b', evidence: ['p1-s2'] }], createdAt: 'x', agent: 'claude', model: null };

test('editConnectionItem: sets text and edited:true, trims; limits and unknown ids', async (t) => {
  const out = await outWith(t, STORED);
  const c = await editConnectionItem(out, 'p1', 'k2', '  새 설명  ');
  assert.deepEqual(c.items[1], { id: 'k2', target: '축 B', text: '새 설명', evidence: ['p1-s2'], edited: true });
  assert.deepEqual(await readConnectionsFile(out, 'p1'), c);
  assert.equal(c.items[0].edited, undefined);
  await assert.rejects(editConnectionItem(out, 'p1', 'k2', 'x'.repeat(301)), (e) => e.status === 400 && /300자/.test(e.message));
  await assert.rejects(editConnectionItem(out, 'p1', 'k2', '   '), (e) => e.status === 400);
  await assert.rejects(editConnectionItem(out, 'p1', 'k2', 5), (e) => e.status === 400);
  await assert.rejects(editConnectionItem(out, 'p1', 'k9', 'x'), (e) => e.status === 404);
  const none = await outWith(t);
  await assert.rejects(editConnectionItem(none, 'p1', 'k1', 'x'), (e) => e.status === 404);
  const broken = await outWith(t, '{broken');
  await assert.rejects(editConnectionItem(broken, 'p1', 'k1', 'x'), (e) => e.status === 500);
  assert.equal(await fs.readFile(path.join(broken, 'p1', 'connections.json'), 'utf8'), '{broken');
});

test('deleteConnectionItem removes one item; unknown → 404; no temp files left', async (t) => {
  const out = await outWith(t, STORED);
  const c = await deleteConnectionItem(out, 'p1', 'k1');
  assert.deepEqual(c.items.map((x) => x.id), ['k2']);
  assert.deepEqual((await readConnectionsFile(out, 'p1')).items.map((x) => x.id), ['k2']);
  await assert.rejects(deleteConnectionItem(out, 'p1', 'k1'), (e) => e.status === 404);
  assert.deepEqual(await fs.readdir(path.join(out, 'p1')), ['connections.json']);
});

// ---- job (fake runAgent) ----

const tick = () => new Promise((r) => setTimeout(r, 5));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await tick(); }
  throw new Error('timeout waiting');
}
const exists = (p) => fs.access(p).then(() => true, () => false);
const RESEARCH = '---\ntags: [x]\n---\n# 연구 주제\n## 축 A: GPU 스케줄링\n```\n# 코드 안 제목\n```\n## 축 B\n';

async function setup(t, { runs, research, agent = 'claude', digest = fullDigest({ paperId: 'p1', cards: 9 }) } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-cjob-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'out');
  await fs.mkdir(path.join(out, 'p1'), { recursive: true });
  await fs.writeFile(path.join(out, 'p1', 'source.json'), JSON.stringify(SOURCE));
  if (digest) await fs.writeFile(path.join(out, 'p1', 'digest.json'), JSON.stringify(digest));
  await fs.mkdir(path.join(tmp, 'examples', 'ex1'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'examples', 'ex1', 'source.json'), JSON.stringify({ ...SOURCE, id: 'ex1' }));
  const calls = [];
  const runAgent = ({ id, workdir, prompt, onLog }) => {
    const call = { id, workdir, prompt, files: null };
    calls.push(call);
    let resolveCancel;
    const cancelled = new Promise((r) => { resolveCancel = r; });
    const done = (async () => {
      call.files = (await fs.readdir(workdir)).sort();
      call.read = {};
      for (const f of call.files) call.read[f] = await fs.readFile(path.join(workdir, f), 'utf8');
      call.modes = {};
      for (const f of call.files) call.modes[f] = (await fs.stat(path.join(workdir, f))).mode & 0o777;
      onLog('읽기: research.md');
      const fn = runs[calls.length - 1] ?? (() => new Promise(() => {}));
      return Promise.race([fn(workdir, call), cancelled]);
    })();
    return { done, cancel() { resolveCancel({ code: null, signal: 'SIGTERM', timedOut: false }); } };
  };
  const jobs = createDigestJobs({
    cfg: { outputDir: out },
    deps: {
      runAgent,
      selectAgent: async () => agent,
      examplesDir: path.join(tmp, 'examples'),
      researchNote: research ?? (async () => ({ path: 'Notes/연구 주제.md', name: '연구 주제', text: RESEARCH })),
    },
  });
  const write = (obj, model) => async (w) => { await fs.writeFile(path.join(w, 'connections.json'), JSON.stringify(obj)); return { code: 0, ...(model ? { model } : {}) }; };
  return { jobs, out, calls, write };
}
const settled = (jobs, id, kind) => waitFor(() => ['done', 'failed', 'cancelled'].includes(jobs.get(id, kind)?.state));

test('connections job: workdir has only the allowed files (0600); done writes connections.json with createdAt/agent/model', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  runs.push(c.write(good([item()]), 'claude-x'));
  const job = await c.jobs.start('p1', { kind: 'connections' });
  assert.equal(job.kind, 'connections');
  assert.equal(job.maxAttempts, CONNECTIONS_ATTEMPTS);
  assert.equal(CONNECTIONS_ATTEMPTS, 2);
  await settled(c.jobs, 'p1', 'connections');
  const done = c.jobs.get('p1', 'connections');
  assert.equal(done.state, 'done', done.message);
  assert.equal(c.jobs.get('p1'), null); // digest job state is separate
  assert.deepEqual(c.calls[0].files, ['TASK.md', 'connections.md', 'digest-core.md', 'paper.txt', 'research.md']);
  for (const m of Object.values(c.calls[0].modes)) assert.equal(m, 0o600);
  assert.equal(c.calls[0].read['research.md'], RESEARCH);
  assert.match(c.calls[0].read['paper.txt'], /\[p1-s1\] GPU 스케줄링을 다룬다\./);
  assert.match(c.calls[0].read['TASK.md'], /p1/);
  assert.match(c.calls[0].read['TASK.md'], /연구 주제/);
  assert.match(c.calls[0].read['TASK.md'], /connections\.json/);
  assert.doesNotMatch(c.calls[0].read['TASK.md'], /Notes\//);
  assert.doesNotMatch(c.calls[0].read['digest-core.md'], /"evidence"/);
  assert.doesNotMatch(c.calls[0].prompt, /검증 문제/);
  const saved = JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'connections.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.paperId, 'p1');
  assert.equal(saved.researchNote, 'Notes/연구 주제.md');
  assert.equal(saved.agent, 'claude');
  assert.equal(saved.model, 'claude-x');
  assert.ok(!Number.isNaN(Date.parse(saved.createdAt)));
  assert.deepEqual(saved.items, [{ id: 'k1', ...item() }]);
  assert.equal(await exists(c.calls[0].workdir), false);
  // the digest is untouched
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'digest.json'), 'utf8')), fullDigest({ paperId: 'p1', cards: 9 }));
});

test('connections job: headings inside code fences are not targets; retry lists problems and carries the previous file; 2 attempts max', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  const bad = good([item({ target: '코드 안 제목' })]);
  runs.push(c.write(bad), c.write(bad));
  await c.jobs.start('p1', { kind: 'connections' });
  await settled(c.jobs, 'p1', 'connections');
  const job = c.jobs.get('p1', 'connections');
  assert.equal(job.state, 'failed');
  assert.equal(job.attempt, 2);
  assert.equal(c.calls.length, 2);
  assert.match(c.calls[1].prompt, /검증 문제/);
  assert.match(c.calls[1].prompt, /코드 안 제목/);
  assert.deepEqual(JSON.parse(c.calls[1].read['connections.json']), bad);
  assert.match(job.message, /기존 연결 메모는 그대로/);
  assert.ok(job.problems.length > 0);
  assert.equal(await exists(path.join(c.out, 'p1', 'connections.json')), false);
});

test('connections job: fail once then pass; regenerating keeps the old file as connections.prev.json', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  await fs.writeFile(path.join(c.out, 'p1', 'connections.json'), JSON.stringify(STORED));
  runs.push(c.write(good([item({ evidence: ['p9-s9'] })])), c.write(good([])));
  await c.jobs.start('p1', { kind: 'connections' });
  await settled(c.jobs, 'p1', 'connections');
  assert.equal(c.jobs.get('p1', 'connections').state, 'done');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'connections.json'), 'utf8')).items, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'connections.prev.json'), 'utf8')), STORED);
});

test('connections job: one job at a time across kinds; 404 unknown, 400 example, research note errors pass through', async (t) => {
  const c = await setup(t, { runs: [] });
  await c.jobs.start('p1', { kind: 'connections' });
  await assert.rejects(c.jobs.start('p1'), (e) => e.status === 409 && /연구 연결 메모/.test(e.message));
  await assert.rejects(c.jobs.start('p1', { kind: 'connections' }), (e) => e.status === 409);
  // digest cancel does not touch the connections job
  assert.equal(c.jobs.cancel('p1'), false);
  await waitFor(() => c.calls.length === 1);
  assert.equal(c.jobs.cancel('p1', 'connections'), true);
  await settled(c.jobs, 'p1', 'connections');
  assert.equal(c.jobs.get('p1', 'connections').state, 'cancelled');
  assert.equal(await exists(c.calls[0].workdir), false);
  await assert.rejects(c.jobs.start('ghost', { kind: 'connections' }), (e) => e.status === 404);
  await assert.rejects(c.jobs.start('ex1', { kind: 'connections' }), (e) => e.status === 400);
  await assert.rejects(c.jobs.start('p1', { kind: 'nope' }), (e) => e.status === 400);

  const err = Object.assign(new Error('Obsidian 설정에서 연구 주제 노트를 먼저 고르세요.'), { status: 400 });
  const r = await setup(t, { runs: [], research: async () => { throw err; } });
  await assert.rejects(r.jobs.start('p1', { kind: 'connections' }), (e) => e.status === 400 && e.message === err.message);
  assert.equal(r.calls.length, 0);
  // a failed start leaves the slot free
  const noHeadings = await setup(t, { runs: [], research: async () => ({ path: 'a.md', name: 'a', text: '제목 없음\n' }) });
  await assert.rejects(noHeadings.jobs.start('p1', { kind: 'connections' }), (e) => e.status === 400 && /제목/.test(e.message));
});

test('connections job while a digest job runs → 409 with the digest message; digest job still completes normally', async (t) => {
  let release;
  const runs = [(w) => new Promise((r) => { release = async () => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(fullDigest({ paperId: 'p1', cards: 9 }))); r({ code: 0 }); }; })];
  const c = await setup(t, { runs, digest: null });
  const j = await c.jobs.start('p1');
  assert.equal(j.kind, 'digest');
  await assert.rejects(c.jobs.start('p1', { kind: 'connections' }), (e) => e.status === 409 && e.message === '다른 논문의 요약을 만들고 있습니다.');
  await waitFor(() => release);
  await release();
  await settled(c.jobs, 'p1');
  assert.equal(c.jobs.get('p1').state, 'done');
  assert.deepEqual(c.calls[0].files, ['TASK.md', 'digest.md', 'figures.txt', 'paper.txt']);
  assert.equal(c.jobs.get('p1', 'connections'), null);
});
