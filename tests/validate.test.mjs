import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDigest } from '../src/digest/validate.mjs';
import { main } from '../src/digest/check-cli.mjs';

const source = {
  id: 'paper1',
  pages: [{ page: 1 }, { page: 2 }, { page: 3 }],
  sentences: {
    'p1-s1': { text: 'A', page: 1 },
    'p1-s2': { text: 'B', page: 1 },
    'p2-s1': { text: 'C', page: 2 },
  },
  figures: [],
};
const card = (over = {}) => ({ id: 'c1', section: 'method', question: 'q', answer: 'a', bridge: '', items: [], ...over });
const TAKE = { text: 't', evidence: ['p1-s1'], why: 'w' };
const d = (cardOver, top = {}) => ({ version: 1, paperId: 'paper1', takeaway: TAKE, cards: [card(cardOver)], glossary: [], ...top });

test('claim with unknown evidence id is removed and reported', () => {
  const { digest, problems } = validateDigest(d({ items: [{ kind: 'claim', text: 'X', evidence: ['p99-s1'] }] }), source);
  assert.equal(digest.cards[0].items.length, 0);
  assert.match(problems[0], /c1: 근거 없는 claim 제거/);
});

test('claim with empty evidence is removed; text truncated to 30 chars in problem', () => {
  const text = '가'.repeat(40);
  const { digest, problems } = validateDigest(d({ items: [{ kind: 'claim', text, evidence: [] }] }), source);
  assert.equal(digest.cards[0].items.length, 0);
  assert.equal(problems[0], `c1: 근거 없는 claim 제거 – ${'가'.repeat(30)}`);
});

test('claim with partially unknown evidence is removed', () => {
  const { digest } = validateDigest(d({ items: [{ kind: 'claim', text: 'X', evidence: ['p1-s1', 'p9-s9'] }] }), source);
  assert.equal(digest.cards[0].items.length, 0);
});

test('valid claim is kept', () => {
  const { digest, problems } = validateDigest(d({ items: [{ kind: 'claim', text: 'X', evidence: ['p1-s1'] }] }), source);
  assert.equal(digest.cards[0].items.length, 1);
  assert.deepEqual(problems, []);
});

test('opinion keeps only existing evidence and is never dropped', () => {
  const { digest } = validateDigest(d({ items: [
    { kind: 'opinion', text: 'O1', evidence: ['p1-s1', 'p9-s9'] },
    { kind: 'opinion', text: 'O2' },
  ] }), source);
  assert.equal(digest.cards[0].items.length, 2);
  assert.deepEqual(digest.cards[0].items[0].evidence, ['p1-s1']);
  assert.deepEqual(digest.cards[0].items[1].evidence, []);
});

test('unknown kind is dropped with a problem', () => {
  const { digest, problems } = validateDigest(d({ items: [{ kind: 'fact', text: 'X', evidence: ['p1-s1'] }] }), source);
  assert.equal(digest.cards[0].items.length, 0);
  assert.match(problems[0], /^c1: /);
});

test('bigNumbers follow the claim rule', () => {
  const { digest, problems } = validateDigest(d({ bigNumbers: [
    { value: '1%', label: 'ok', evidence: ['p2-s1'] },
    { value: '2%', label: 'bad', evidence: ['p8-s1'] },
  ] }), source);
  assert.equal(digest.cards[0].bigNumbers.length, 1);
  assert.equal(digest.cards[0].bigNumbers[0].value, '1%');
  assert.match(problems[0], /c1: /);
});

test('invalid takeaway evidence keeps the text and reports', () => {
  const { digest, problems } = validateDigest(d({}, { takeaway: { text: 'T', evidence: ['p9-s9'], why: 'w' } }), source);
  assert.equal(digest.takeaway.text, 'T');
  assert.match(problems[0], /^takeaway: /);
});

test('figure with out-of-range page is removed', () => {
  const { digest, problems } = validateDigest(d({ figures: [
    { label: 'Figure 1', page: 3, note: '' },
    { label: 'Figure 2', page: 4, note: '' },
    { label: 'Figure 3', page: 0, note: '' },
  ] }), source);
  assert.deepEqual(digest.cards[0].figures.map((f) => f.label), ['Figure 1']);
  assert.equal(problems.length, 2);
});

test('unknown section adds a problem but keeps the card', () => {
  const { digest, problems } = validateDigest(d({ section: 'intro' }), source);
  assert.equal(digest.cards.length, 1);
  assert.match(problems[0], /c1: /);
});

test('garbage input returns empty digest with problem, no throw', () => {
  for (const bad of ['oops', null, undefined, 42, [], { cards: 'x' }]) {
    const { digest, problems } = validateDigest(bad, source);
    assert.deepEqual(digest, { version: 1, paperId: 'paper1', takeaway: null, cards: [], glossary: [] });
    assert.deepEqual(problems, ['digest.json 형식이 올바르지 않습니다']);
  }
});

test('does not mutate input; tolerates malformed cards/items', () => {
  const input = d({ items: [{ kind: 'claim', text: 'X', evidence: ['p9-s9'] }, null, 'x'] });
  input.cards.push(null);
  const copy = structuredClone(input);
  assert.doesNotThrow(() => validateDigest(input, { id: 'paper1' }));
  validateDigest(input, source);
  assert.deepEqual(input, copy);
});

async function setup({ digest, src = source }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-'));
  const cfgPath = path.join(dir, 'cfg.json');
  await fs.writeFile(cfgPath, JSON.stringify({ outputDir: path.join(dir, 'out') }));
  const pdir = path.join(dir, 'out', 'paper1');
  await fs.mkdir(pdir, { recursive: true });
  if (src !== null) await fs.writeFile(path.join(pdir, 'source.json'), typeof src === 'string' ? src : JSON.stringify(src));
  if (digest !== undefined) await fs.writeFile(path.join(pdir, 'digest.json'), typeof digest === 'string' ? digest : JSON.stringify(digest));
  return { cfgPath, pdir };
}
const run = async (argv, cwdCfg) => {
  const out = [], err = [];
  const code = await main(argv, { configPath: cwdCfg, log: (m) => out.push(m), error: (m) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('check CLI passes on valid digest', async () => {
  const { cfgPath } = await setup({ digest: d({ items: [{ kind: 'claim', text: 'X', evidence: ['p1-s1'] }] }) });
  const r = await run(['paper1'], cfgPath);
  assert.equal(r.code, 0);
  assert.match(r.out, /검증 통과: 카드 1개, claim 1개/);
});

test('check CLI fails with problems', async () => {
  const { cfgPath } = await setup({ digest: d({ items: [{ kind: 'claim', text: 'X', evidence: ['p9-s9'] }] }) });
  const r = await run(['paper1'], cfgPath);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /c1: 근거 없는 claim 제거/);
});

test('check CLI: missing digest, missing source, bad JSON, no id', async () => {
  let s = await setup({});
  let r = await run(['paper1'], s.cfgPath);
  assert.equal(r.code, 1);
  assert.match(r.err, /digest\.json이 없습니다: .*digest\.json/);
  s = await setup({ digest: d(), src: null });
  r = await run(['paper1'], s.cfgPath);
  assert.equal(r.code, 1);
  assert.match(r.err, /source\.json이 없습니다/);
  s = await setup({ digest: '{bad' });
  r = await run(['paper1'], s.cfgPath);
  assert.equal(r.code, 1);
  assert.match(r.err, /JSON/);
  r = await run([], s.cfgPath);
  assert.equal(r.code, 1);
  assert.match(r.err, /사용법/);
});

test('missing or non-object takeaway is reported', () => {
  for (const takeaway of [undefined, null, 'text', []]) {
    const { digest, problems } = validateDigest(d({}, { takeaway }), source);
    assert.equal(digest.takeaway, null);
    assert.deepEqual(problems, ['takeaway: 없음 – 0번 Takeaway를 작성하세요']);
  }
});

test('duplicate card ids are reported and renamed uniquely', () => {
  const dig = { version: 1, paperId: 'paper1', takeaway: TAKE, glossary: [],
    cards: [card({ id: 'c1' }), card({ id: 'c1' }), card({ id: 'c1-2' }), card({ id: 'c1' })] };
  const { digest, problems } = validateDigest(dig, source);
  // ids written in the file are reserved first, so the genuine 'c1-2' keeps its id (and its read progress)
  assert.deepEqual(digest.cards.map((c) => c.id), ['c1', 'c1-3', 'c1-2', 'c1-4']);
  assert.deepEqual(problems, ['c1: 카드 id 중복', 'c1: 카드 id 중복']);
});
