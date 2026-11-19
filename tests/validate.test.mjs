import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDigest, minCards, sentenceCount } from '../src/digest/validate.mjs';
import { main } from '../src/digest/check-cli.mjs';
import { fullDigest } from './fixtures/digest-fixture.mjs';

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
// The one-card digests above fail the whole-paper coverage checks; most tests look only at the rest.
const COVERAGE = /^카드가 \d+장입니다|^빠진 섹션: |^결과 카드에 숫자|: explain\(해설\)을 2~4문장으로 쓰세요$/;
const own = (problems) => problems.filter((p) => !COVERAGE.test(p));

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
  assert.deepEqual(own(problems), []);
});

test('opinion items are removed and reported, whatever their evidence', () => {
  const { digest, problems } = validateDigest(d({ items: [
    { kind: 'claim', text: 'C', evidence: ['p1-s1'] },
    { kind: 'opinion', text: 'O1', evidence: ['p1-s1', 'p9-s9'] },
    { kind: 'opinion', text: '가'.repeat(40) },
  ] }), source);
  assert.deepEqual(digest.cards[0].items.map((i) => i.kind), ['claim']);
  assert.deepEqual(own(problems), [
    'c1: 해석·의견 항목은 쓰지 않습니다 – O1',
    `c1: 해석·의견 항목은 쓰지 않습니다 – ${'가'.repeat(30)}`,
  ]);
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
  assert.equal(own(problems).length, 2);
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
  const { cfgPath } = await setup({ digest: fullDigest({ paperId: 'paper1', cards: 9 }) });
  const r = await run(['paper1'], cfgPath);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /검증 통과: 카드 9개, claim 9개/);
});

test('check CLI fails on a digest that does not cover the paper', async () => {
  const { cfgPath } = await setup({ digest: d({ items: [{ kind: 'claim', text: 'X', evidence: ['p1-s1'] }] }) });
  const r = await run(['paper1'], cfgPath);
  assert.equal(r.code, 1);
  assert.match(r.err, /카드가 1장입니다 – 논문 전체를 담도록 8장 이상 쓰세요/);
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
    assert.deepEqual(own(problems), ['takeaway: 없음 – 0번 Takeaway를 작성하세요']);
  }
});

test('duplicate card ids are reported and renamed uniquely', () => {
  const dig = { version: 1, paperId: 'paper1', takeaway: TAKE, glossary: [],
    cards: [card({ id: 'c1' }), card({ id: 'c1' }), card({ id: 'c1-2' }), card({ id: 'c1' })] };
  const { digest, problems } = validateDigest(dig, source);
  // ids written in the file are reserved first, so the genuine 'c1-2' keeps its id (and its read progress)
  assert.deepEqual(digest.cards.map((c) => c.id), ['c1', 'c1-3', 'c1-2', 'c1-4']);
  assert.deepEqual(own(problems), ['c1: 카드 id 중복', 'c1: 카드 id 중복']);
});

test('explain and item label are kept as strings', () => {
  const { digest, problems } = validateDigest(d({
    explain: '해설 문단이다. 둘째 문장이다.',
    items: [{ kind: 'claim', label: '소제목', text: 'X', evidence: ['p1-s1'] }, { kind: 'claim', text: 'Y', evidence: ['p1-s2'] }],
  }), source);
  assert.deepEqual(own(problems), []);
  assert.equal(digest.cards[0].explain, '해설 문단이다. 둘째 문장이다.');
  assert.equal(digest.cards[0].items[0].label, '소제목');
  assert.equal(digest.cards[0].items[1].label, '');
});

test('missing explain/tables default to empty', () => {
  const { digest } = validateDigest(d({}), source);
  assert.equal(digest.cards[0].explain, '');
  assert.deepEqual(digest.cards[0].tables, []);
});

test('table with known evidence and consistent shape is kept', () => {
  const t = { title: 'Table 3 재구성', columns: ['Agent', 'Acc.'], rows: [['A', '1%'], ['B', '2%']], evidence: ['p2-s1'], note: 'n' };
  const { digest, problems } = validateDigest(d({ tables: [t] }), source);
  assert.deepEqual(own(problems), []);
  assert.deepEqual(digest.cards[0].tables, [t]);
});

test('table without valid evidence is removed and reported', () => {
  const t = { title: 'T', columns: ['a'], rows: [['1']], evidence: ['p9-s9'] };
  const { digest, problems } = validateDigest(d({ tables: [t] }), source);
  assert.deepEqual(digest.cards[0].tables, []);
  assert.match(problems[0], /c1: 근거 없는 표 제거 – T/);
});

test('table with mismatched row length or no columns is removed and reported', () => {
  const bad1 = { title: 'R', columns: ['a', 'b'], rows: [['1']], evidence: ['p1-s1'] };
  const bad2 = { title: 'C', columns: [], rows: [], evidence: ['p1-s1'] };
  const { digest, problems } = validateDigest(d({ tables: [bad1, bad2] }), source);
  assert.deepEqual(digest.cards[0].tables, []);
  assert.match(problems[0], /c1: 형식이 맞지 않는 표 제거 – R/);
  assert.match(problems[1], /c1: 형식이 맞지 않는 표 제거 – C/);
});

// --- whole-paper coverage (paper-only cards) ---

const LONG = { ...source, pages: Array.from({ length: 7 }, (_, i) => ({ page: i + 1 })) };

test('minCards: 12 for papers over 6 pages, 8 for short papers', () => {
  assert.equal(minCards(LONG), 12);
  assert.equal(minCards({ ...source, pages: Array.from({ length: 6 }, (_, i) => ({ page: i + 1 })) }), 8);
  assert.equal(minCards(source), 8);
  assert.equal(minCards({}), 12);
});

test('a full digest has no problems', () => {
  assert.deepEqual(validateDigest(fullDigest({ paperId: 'paper1' }), LONG).problems, []);
  assert.deepEqual(validateDigest(fullDigest({ paperId: 'paper1', cards: 9 }), source).problems, []);
});

test('too few cards is reported with the threshold for the paper length', () => {
  const short = fullDigest({ paperId: 'paper1', cards: 11 });
  assert.deepEqual(validateDigest(short, LONG).problems, ['카드가 11장입니다 – 논문 전체를 담도록 12장 이상 쓰세요']);
  assert.deepEqual(validateDigest(short, source).problems, []);
  const tiny = { ...short, cards: short.cards.slice(0, 7) };
  assert.ok(validateDigest(tiny, source).problems.includes('카드가 7장입니다 – 논문 전체를 담도록 8장 이상 쓰세요'));
});

test('missing sections are listed in section order', () => {
  const full = fullDigest({ paperId: 'paper1' });
  const dig = { ...full, cards: full.cards.filter((c) => c.section !== 'gap' && c.section !== 'limits') };
  dig.cards.push(...full.cards.filter((c) => c.section === 'method').map((c, i) => ({ ...c, id: `m${i}` })));
  const { problems } = validateDigest(dig, LONG);
  assert.deepEqual(problems, ['빠진 섹션: gap, limits']);
});

test('results cards without bigNumbers or tables are reported once', () => {
  const full = fullDigest({ paperId: 'paper1' });
  const dig = { ...full, cards: full.cards.map((c) => (c.section === 'results' ? { ...c, bigNumbers: [] } : c)) };
  assert.deepEqual(validateDigest(dig, LONG).problems, ['결과 카드에 숫자(bigNumbers)나 표(tables)가 없습니다']);
  // A table on any results card is enough; a bigNumber removed for bad evidence does not count.
  const withTable = { ...dig, cards: dig.cards.map((c) => (c.section === 'results' ? { ...c, tables: [{ title: 'T', columns: ['a'], rows: [['1']], evidence: ['p1-s1'] }] } : c)) };
  assert.deepEqual(validateDigest(withTable, LONG).problems, []);
  const badEv = { ...full, cards: full.cards.map((c) => (c.section === 'results' ? { ...c, bigNumbers: [{ value: '1', label: 'x', evidence: ['p9-s9'] }] } : c)) };
  assert.ok(validateDigest(badEv, LONG).problems.includes('결과 카드에 숫자(bigNumbers)나 표(tables)가 없습니다'));
});

test('sentenceCount: Korean "다." endings, English "." endings, decimals are not breaks', () => {
  assert.equal(sentenceCount(''), 0);
  assert.equal(sentenceCount('   '), 0);
  assert.equal(sentenceCount('한 문장이다.'), 1);
  assert.equal(sentenceCount('첫째 문장이다. 둘째 문장이다.'), 2);
  assert.equal(sentenceCount('첫째 문장이다.둘째 문장이다.'), 2);
  assert.equal(sentenceCount('It works. It also scales.'), 2);
  assert.equal(sentenceCount('정확도는 13.9%였다. F1은 0.89다.'), 2);
  assert.equal(sentenceCount('왜 그럴까? 이유는 둘이다! 하나는 이것이다'), 3);
  assert.equal(sentenceCount('첫째 문장이다\n둘째 문장이다'), 2);
});

test('explain must be 2 or more sentences on every card', () => {
  const full = fullDigest({ paperId: 'paper1' });
  const dig = { ...full, cards: full.cards.map((c, i) => (i === 0 ? { ...c, explain: '' } : i === 1 ? { ...c, explain: '한 문장뿐이다.' } : i === 2 ? { ...c, explain: 'One. Two.' } : c)) };
  assert.deepEqual(validateDigest(dig, LONG).problems, [
    'c1: explain(해설)을 2~4문장으로 쓰세요',
    'c2: explain(해설)을 2~4문장으로 쓰세요',
  ]);
});

test('claim text over 100 characters is reported but kept', () => {
  const full = fullDigest({ paperId: 'paper1' });
  full.cards[0].items = [
    { kind: 'claim', text: '가'.repeat(100), evidence: ['p1-s1'] },
    { kind: 'claim', text: '나'.repeat(101), evidence: ['p1-s1'] },
  ];
  const { digest, problems } = validateDigest(full, LONG);
  assert.equal(digest.cards[0].items.length, 2);
  assert.deepEqual(problems, ['c1: 문장이 깁니다(101자) – 나눠 쓰세요']);
});

test('an old digest with opinions (AIOpsLab-like) opens with opinions removed and each reported', () => {
  const full = fullDigest({ paperId: 'paper1' });
  const ops = Array.from({ length: 8 }, (_, i) => ({ kind: 'opinion', text: `의견 ${i + 1}`, evidence: [] }));
  const old = { ...full, cards: full.cards.map((c, i) => (i < 4 ? { ...c, items: [...c.items, ops[2 * i], ops[2 * i + 1]] } : c)) };
  const { digest, problems } = validateDigest(old, LONG);
  assert.equal(digest.cards.length, 12);
  assert.ok(digest.cards.every((c) => c.items.every((it) => it.kind === 'claim')));
  assert.equal(problems.length, 8);
  assert.equal(problems[0], 'c1: 해석·의견 항목은 쓰지 않습니다 – 의견 1');
  assert.equal(problems[7], 'c4: 해석·의견 항목은 쓰지 않습니다 – 의견 8');
});
