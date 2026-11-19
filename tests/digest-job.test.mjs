import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDigestJobs, redactPaths } from '../src/agent/digest-job.mjs';
import { fullDigest } from './fixtures/digest-fixture.mjs';

const SOURCE = {
  id: 'p1',
  meta: { title: 'T' },
  pages: [{ page: 1 }],
  sentences: { 'p1-s1': { text: 'a', page: 1 }, 'p1-s2': { text: 'b', page: 1 } },
};
// One-page source: 8 cards minimum, but all nine sections are needed.
const GOOD = fullDigest({ paperId: 'p1', evidence: 'p1-s2', cards: 9 });
const BAD = { ...GOOD, cards: [{ ...GOOD.cards[0], items: [{ kind: 'claim', text: 'bad', evidence: ['p9-s9'] }] }] };
const OLD = { ...GOOD, takeaway: { text: 'old', evidence: ['p1-s1'], why: 'w' } };

const tick = () => new Promise((r) => setTimeout(r, 5));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await tick();
  }
  throw new Error('timeout waiting');
}
const exists = (p) => fs.access(p).then(() => true, () => false);

// outputDir with p1 (source + old digest), an example paper, and a rules file.
async function setup(t, { pdfIds = [], extract, runs, agent = 'claude', researchContext } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-job-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'out');
  await fs.mkdir(path.join(out, 'p1'), { recursive: true });
  await fs.writeFile(path.join(out, 'p1', 'source.json'), JSON.stringify(SOURCE));
  await fs.writeFile(path.join(out, 'p1', 'digest.json'), JSON.stringify(OLD));
  const rulesFile = path.join(tmp, 'rules.md');
  await fs.writeFile(rulesFile, 'rules');
  const calls = [];
  const workdirs = [];
  // runs: array of (workdir, call) => result | Promise, one per attempt.
  const runAgent = ({ id, workdir, prompt, onLog }) => {
    const call = { id, workdir, prompt, files: null, cancelled: false, onLog };
    calls.push(call);
    workdirs.push(workdir);
    let resolveCancel;
    const cancelled = new Promise((r) => { resolveCancel = r; });
    const done = (async () => {
      call.files = (await fs.readdir(workdir)).sort();
      call.prevDigest = await fs.readFile(path.join(workdir, 'digest.json'), 'utf8').catch(() => null);
      onLog('도구 사용: Read source.json');
      const fn = runs[calls.length - 1];
      return Promise.race([fn(workdir, call), cancelled]);
    })();
    return { done, cancel() { call.cancelled = true; resolveCancel({ code: null, signal: 'SIGTERM', timedOut: false }); } };
  };
  const writeDigest = (obj) => async (w) => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(obj)); return { code: 0, signal: null, timedOut: false }; };
  const cfg = { outputDir: out, researchContextFile: researchContext ?? null };
  const jobs = createDigestJobs({
    cfg,
    deps: {
      runAgent,
      rulesFile,
      selectAgent: async () => agent,
      findFolderPdf: async (id) => pdfIds.includes(id),
      extract: extract ?? (async () => { throw new Error('no extract'); }),
      examplesDir: path.join(tmp, 'examples'),
    },
  });
  await fs.mkdir(path.join(tmp, 'examples', 'ex1'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'examples', 'ex1', 'source.json'), JSON.stringify({ ...SOURCE, id: 'ex1' }));
  return { jobs, out, calls, workdirs, writeDigest, tmp };
}

const settled = (jobs, id) => waitFor(() => ['done', 'failed', 'cancelled'].includes(jobs.get(id)?.state));

test('first attempt passes: done, digest.json replaced, digest.prev.json keeps the old one, workdir removed', async (t) => {
  const runs = [];
  const c2 = await setup(t, { runs });
  runs.push(c2.writeDigest(GOOD));
  const job = await c2.jobs.start('p1');
  assert.equal(job.paperId, 'p1');
  assert.equal(job.agent, 'claude');
  assert.equal(job.maxAttempts, 3);
  assert.ok(['writing', 'checking', 'done'].includes(job.state));
  assert.equal(typeof job.startedAt, 'string');
  await settled(c2.jobs, 'p1');
  const done = c2.jobs.get('p1');
  assert.equal(done.state, 'done', done.message);
  assert.equal(done.attempt, 1);
  assert.equal(typeof done.finishedAt, 'string');
  assert.ok(done.log.some((l) => l.includes('Read source.json')));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c2.out, 'p1', 'digest.json'), 'utf8')), GOOD);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c2.out, 'p1', 'digest.prev.json'), 'utf8')), OLD);
  assert.deepEqual(c2.calls[0].files, ['TASK.md', 'digest.md', 'source.json']);
  assert.equal(c2.calls[0].id, 'claude');
  assert.equal(await exists(c2.workdirs[0]), false);
  assert.deepEqual((await fs.readdir(path.join(c2.out, 'p1'))).sort(), ['digest.json', 'digest.prev.json', 'source.json']);
});

test('a leftover researchContextFile setting is ignored silently', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-ctx-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const ctxFile = path.join(tmp, 'ctx.md');
  await fs.writeFile(ctxFile, 'my research');
  const runs = [async (w) => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(GOOD)); return { code: 0 }; }];
  const c = await setup(t, { runs, researchContext: ctxFile });
  await c.jobs.start('p1');
  await settled(c.jobs, 'p1');
  const job = c.jobs.get('p1');
  assert.equal(job.state, 'done', job.message);
  assert.deepEqual(c.calls[0].files, ['TASK.md', 'digest.md', 'source.json']);
  assert.ok(!job.log.some((l) => l.includes('연구 맥락')));
});

test('a digest with an opinion item is retried with the opinion problem', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  const withOpinion = structuredClone(GOOD);
  withOpinion.cards[0].items.push({ kind: 'opinion', text: '이 결과는 의미 있다', evidence: [] });
  runs.push(c.writeDigest(withOpinion), c.writeDigest(GOOD));
  await c.jobs.start('p1');
  await settled(c.jobs, 'p1');
  assert.equal(c.jobs.get('p1').state, 'done');
  assert.match(c.calls[1].prompt, /c1: 해석·의견 항목은 쓰지 않습니다 – 이 결과는 의미 있다/);
});

test('fail once then pass: attempt 2, second prompt lists the problems, previous digest kept in workdir', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  runs.push(c.writeDigest(BAD), c.writeDigest(GOOD));
  const states = new Set();
  await c.jobs.start('p1');
  await waitFor(() => { states.add(c.jobs.get('p1').state); return ['done', 'failed'].includes(c.jobs.get('p1').state); });
  const job = c.jobs.get('p1');
  assert.equal(job.state, 'done');
  assert.equal(job.attempt, 2);
  assert.equal(c.calls.length, 2);
  assert.doesNotMatch(c.calls[0].prompt, /검증 문제/);
  assert.match(c.calls[1].prompt, /근거 없는 claim 제거 – bad/);
  assert.deepEqual(JSON.parse(c.calls[1].prevDigest), BAD);
  for (const w of c.workdirs) assert.equal(await exists(w), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'digest.json'), 'utf8')), GOOD);
});

test('three failures: failed with problems, existing digest untouched, no prev file', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  runs.push(c.writeDigest(BAD), async () => ({ code: 0 }), c.writeDigest(BAD));
  await c.jobs.start('p1');
  await settled(c.jobs, 'p1');
  const job = c.jobs.get('p1');
  assert.equal(job.state, 'failed');
  assert.equal(job.attempt, 3);
  assert.equal(c.calls.length, 3);
  assert.match(c.calls[2].prompt, /digest\.json/);
  assert.ok(job.problems.length > 0);
  assert.match(job.message, /기존 요약은 그대로/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'digest.json'), 'utf8')), OLD);
  assert.equal(await exists(path.join(c.out, 'p1', 'digest.prev.json')), false);
  for (const w of c.workdirs) assert.equal(await exists(w), false);
});

test('tool exits non-zero with errorHint: failed with that message, no retry', async (t) => {
  const runs = [async () => ({ code: 1, signal: null, timedOut: false, errorHint: 'AI 도구 로그인이 필요합니다.' })];
  const c = await setup(t, { runs });
  await c.jobs.start('p1');
  await settled(c.jobs, 'p1');
  const job = c.jobs.get('p1');
  assert.equal(job.state, 'failed');
  assert.equal(job.message, 'AI 도구 로그인이 필요합니다.');
  assert.equal(c.calls.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'digest.json'), 'utf8')), OLD);
});

test('timeout: failed with the timeout message', async (t) => {
  const runs = [async () => ({ code: null, signal: 'SIGTERM', timedOut: true })];
  const c = await setup(t, { runs });
  await c.jobs.start('p1');
  await settled(c.jobs, 'p1');
  assert.equal(c.jobs.get('p1').message, '시간이 너무 오래 걸려 멈췄습니다.');
});

test('cancel: cancelled, tool cancelled, workdir removed, digest untouched', async (t) => {
  const runs = [() => new Promise(() => {})];
  const c = await setup(t, { runs });
  await c.jobs.start('p1');
  await waitFor(() => c.calls.length === 1 && c.calls[0].files);
  assert.equal(c.jobs.cancel('p1'), true);
  assert.equal(c.jobs.cancel('nope'), false);
  await settled(c.jobs, 'p1');
  assert.equal(c.jobs.get('p1').state, 'cancelled');
  assert.equal(c.calls[0].cancelled, true);
  assert.equal(await exists(c.workdirs[0]), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'digest.json'), 'utf8')), OLD);
  assert.equal(c.jobs.cancel('p1'), false);
});

test('shutdown cancels the running job and removes the workdir', async (t) => {
  const runs = [() => new Promise(() => {})];
  const c = await setup(t, { runs });
  await c.jobs.start('p1');
  await waitFor(() => c.calls.length === 1 && c.calls[0].files);
  await c.jobs.shutdown();
  assert.equal(c.calls[0].cancelled, true);
  assert.equal(await exists(c.workdirs[0]), false);
  assert.equal(c.jobs.get('p1').state, 'cancelled');
});

test('folder PDF (not yet extracted): extracting first, then writing', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const runs = [];
  const extracted = [];
  let c;
  const extract = async (id) => {
    extracted.push(id);
    await gate;
    await fs.mkdir(path.join(c.out, id), { recursive: true });
    await fs.writeFile(path.join(c.out, id, 'source.json'), JSON.stringify({ ...SOURCE, id }));
  };
  c = await setup(t, { runs, pdfIds: ['f1'], extract });
  runs.push(c.writeDigest({ ...GOOD, paperId: 'f1' }));
  const job = await c.jobs.start('f1');
  assert.equal(job.state, 'extracting');
  await waitFor(() => extracted.length === 1);
  assert.equal(c.jobs.get('f1').state, 'extracting');
  release();
  await settled(c.jobs, 'f1');
  assert.equal(c.jobs.get('f1').state, 'done');
  assert.deepEqual(extracted, ['f1']);
  assert.equal(JSON.parse(await fs.readFile(path.join(c.out, 'f1', 'digest.json'), 'utf8')).paperId, 'f1');
  assert.equal(await exists(path.join(c.out, 'f1', 'digest.prev.json')), false);
});

test('extraction failure: failed with the extraction reason, tool never runs', async (t) => {
  const runs = [];
  const extract = async () => { const e = new Error('텍스트를 추출할 수 없습니다(스캔 PDF로 보입니다).'); e.status = 500; throw e; };
  const c = await setup(t, { runs, pdfIds: ['f1'], extract });
  await c.jobs.start('f1');
  await settled(c.jobs, 'f1');
  assert.equal(c.jobs.get('f1').state, 'failed');
  assert.match(c.jobs.get('f1').message, /스캔 PDF/);
  assert.equal(c.calls.length, 0);
});

test('start errors: 409 while running, 404 unknown, 400 example, 400 no tool', async (t) => {
  let release;
  const runs = [(w) => new Promise((r) => { release = async () => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(GOOD)); r({ code: 0 }); }; })];
  const c = await setup(t, { runs, pdfIds: ['f1'] });
  await c.jobs.start('p1');
  await assert.rejects(c.jobs.start('f1'), (e) => e.status === 409 && e.message === '다른 논문의 요약을 만들고 있습니다.');
  await assert.rejects(c.jobs.start('p1'), (e) => e.status === 409);
  await waitFor(() => release);
  await release();
  await settled(c.jobs, 'p1');
  await assert.rejects(c.jobs.start('ghost'), (e) => e.status === 404);
  await assert.rejects(c.jobs.start('ex1'), (e) => e.status === 400 && e.message === '예제 논문은 요약을 다시 만들 수 없습니다.');
  assert.equal(c.jobs.get('ghost'), null);
  const none = await setup(t, { runs: [], agent: null });
  await assert.rejects(none.jobs.start('p1'), (e) => e.status === 400 && e.message === '쓸 수 있는 AI 도구가 없습니다. Claude Code나 Codex를 설치하고 로그인하세요.');
  // a finished job stays queryable; failed start does not replace it
  assert.equal(c.jobs.get('p1').state, 'done');
});

test('concurrent start calls: exactly one wins', async (t) => {
  const runs = [() => new Promise(() => {})];
  const c = await setup(t, { runs });
  const r = await Promise.allSettled([c.jobs.start('p1'), c.jobs.start('p1')]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(r.find((x) => x.status === 'rejected').reason.status, 409);
  await c.jobs.shutdown();
});

test('log keeps the last 20 lines, each at most 200 chars; job snapshot is a copy', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  runs.push(async (w, call) => {
    for (let i = 0; i < 30; i += 1) call.onLog(`${i} ${'x'.repeat(300)}`);
    await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(GOOD));
    return { code: 0 };
  });
  await c.jobs.start('p1');
  await settled(c.jobs, 'p1');
  const j = c.jobs.get('p1');
  assert.equal(j.log.length, 20);
  assert.ok(j.log.every((l) => l.length <= 200));
  assert.ok(!j.log.some((l) => l.startsWith('0 x')));
  j.state = 'x';
  j.log.push('y');
  assert.equal(c.jobs.get('p1').state, 'done');
  assert.equal(c.jobs.get('p1').log.length, 20);
});

test('redactPaths replaces absolute and ~ paths with their basename, keeps other text', () => {
  assert.equal(redactPaths("EACCES: permission denied, open '/Users/me/out/p1/.digest.json.1.tmp'"), "EACCES: permission denied, open '.digest.json.1.tmp'");
  assert.equal(redactPaths('File "/Users/me/paper reader/extract/run.py", line 3'), 'File "run.py", line 3');
  assert.equal(redactPaths('읽을 수 없음: /Users/me/papers/a.pdf (손상)'), '읽을 수 없음: a.pdf (손상)');
  assert.equal(redactPaths('cwd=/private/var/folders/x/paper-reader-digest-abc/'), 'cwd=paper-reader-digest-abc');
  assert.equal(redactPaths('see ~/papers/2501.06706v1.pdf now'), 'see 2501.06706v1.pdf now');
  assert.equal(redactPaths('C:\\Users\\me\\a.pdf'), 'a.pdf');
  assert.equal(redactPaths('http://127.0.0.1:5173/api/papers 와 A/B 시험, 1/2, /tmp'), 'http://127.0.0.1:5173/api/papers 와 A/B 시험, 1/2, /tmp');
  assert.equal(redactPaths(undefined), '');
});

test('unexpected error (digest save fails): fixed message without paths, raw error only on console', async (t) => {
  const runs = [];
  const c = await setup(t, { runs });
  runs.push(async (w) => {
    await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(GOOD));
    await fs.chmod(path.join(c.out, 'p1'), 0o500); // tmp write into the paper dir fails
    return { code: 0 };
  });
  t.after(() => fs.chmod(path.join(c.out, 'p1'), 0o700).catch(() => {}));
  const logged = [];
  t.mock.method(console, 'error', (...a) => { logged.push(a.map(String).join(' ')); });
  await c.jobs.start('p1');
  await settled(c.jobs, 'p1');
  const job = c.jobs.get('p1');
  assert.equal(job.state, 'failed');
  assert.equal(job.message, '요약을 만들지 못했습니다. 기존 요약은 그대로입니다. 서버 로그를 확인하세요. (EACCES)');
  assert.ok(!JSON.stringify(job).includes(c.tmp));
  assert.ok(logged.some((l) => l.includes(c.tmp)));
  await fs.chmod(path.join(c.out, 'p1'), 0o700);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(c.out, 'p1', 'digest.json'), 'utf8')), OLD);
});

test('paths in extraction errors, tool logs and error hints are redacted', async (t) => {
  const extract = async () => { throw new Error(`PDF를 열 수 없습니다: /Users/someone/papers/secret dir/x.pdf\ntrace`); };
  const c = await setup(t, { runs: [], pdfIds: ['f1'], extract });
  await c.jobs.start('f1');
  await settled(c.jobs, 'f1');
  // Unquoted paths with spaces: everything up to the space collapses to its last segment (no home dir left).
  assert.equal(c.jobs.get('f1').message, 'PDF를 열 수 없습니다: secret dir/x.pdf');

  const runs = [];
  const d = await setup(t, { runs });
  runs.push(async (w, call) => {
    call.onLog(`오류: cannot write ${w}/digest.json`);
    return { code: 1, errorHint: `실패: '${w}/x'` };
  });
  await d.jobs.start('p1');
  await settled(d.jobs, 'p1');
  const j = d.jobs.get('p1');
  assert.ok(!JSON.stringify(j).includes(d.workdirs[0]), JSON.stringify(j));
  assert.ok(j.log.includes('오류: cannot write digest.json'));
  assert.equal(j.message, "실패: 'x'");
});

test('cancel during an extraction that then fails ends cancelled, not failed', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const extract = async () => { await gate; throw new Error('추출 실패'); };
  const c = await setup(t, { runs: [], pdfIds: ['f1'], extract });
  await c.jobs.start('f1');
  assert.equal(c.jobs.cancel('f1'), true);
  release();
  await settled(c.jobs, 'f1');
  assert.equal(c.jobs.get('f1').state, 'cancelled');
});
