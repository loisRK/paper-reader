import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BEGIN, END, MARKER_ERROR, USER_SECTION, buildPaperNote, buildSummaryNote, mergeManaged, paperNoteFileName, summaryNoteFileName,
  noteKeywords, researchHeadings, signalOf,
} from '../src/obsidian/note.mjs';
import { writeNotes, sanitizeFileName, listVaultNotes } from '../src/obsidian/write.mjs';
import { validateObsidianSettings, DEFAULT_FOLDER, DEFAULT_SUMMARY_FOLDER } from '../src/obsidian/settings.mjs';
import { readSettings, writeSettings } from '../src/library/settings.mjs';

const NOW = '2026-11-20T01:02:03.000Z';
const source = {
  id: 'KimEtAlX2025',
  zotero: { itemKey: 'ITEM0001', attachmentKey: 'ATT00001' },
  meta: { title: 'A  Paper\nTitle', doi: '10.1/x', authors: ['Kim A', 'Lee "B"'], date: '2025-03-01' },
  pages: [{ page: 1 }, { page: 2 }, { page: 3 }],
  sentences: {
    'p1-s1': { text: 'First   sentence.', page: 1 },
    'p1-s2': { text: 'Second sentence.', page: 1 },
    'p2-s1': { text: 'Page two %% end paper-reader %% text.', page: 2 },
    'p2-s2': { text: 'Page two more.', page: 2 },
    'p3-s1': { text: 'Page three.', page: 3 },
  },
};
const digest = {
  version: 1, paperId: 'KimEtAlX2025',
  takeaway: { text: '핵심 문장이다.', evidence: ['p1-s1', 'p3-s1'], why: 'w' },
  cards: [
    {
      id: 'c1', section: 'motivation', question: '왜 필요한가?', answer: '답이다.', explain: '쉬운  설명이다.', bridge: '',
      items: [{ kind: 'claim', label: '', text: '주장 하나.', evidence: ['p1-s2'] },
        { kind: 'claim', label: '', text: '주장 둘.', evidence: ['p2-s2', 'p3-s1'] }],
      bigNumbers: [], tables: [], figures: [],
    },
    {
      id: 'c2', section: 'results', question: '결과는?', answer: '좋다.', explain: 'e', bridge: '',
      items: [],
      bigNumbers: [{ value: '42%', label: '정확도', evidence: ['p2-s2'] }],
      tables: [{ title: '표 1', columns: ['모델', '점수'], rows: [['A', '1|2']], evidence: ['p3-s1'], note: '' }],
      figures: [],
    },
  ],
  glossary: [{ term: '용어 하나(term one)', definition: 'd' }],
  keywords: ['AIOps', 'LLM agent', 'fault localization'],
};
const notes = {
  highlights: [
    { id: 'h1', sentenceIds: ['p2-s2', 'p2-s1'], color: '#ffd400', comment: '천천히\n두 줄' },
    { id: 'h2', sentenceIds: ['p1-s1'], color: '#ff6666', comment: '' },
    { id: 'h3', sentenceIds: ['p3-s1'], color: '#5fb236', comment: '배경' },
    { id: 'h4', sentenceIds: ['p1-s2'], color: '#2ea8e5', comment: '' },
  ],
  zoteroAnnotations: [{ key: 'Z1', page: 2, sentenceIds: ['p2-s2'], text: 'Page two more.', comment: '저테로', color: '#a28ae5' }],
  cardMemos: { c1: '카드 메모\n둘째 줄', takeaway: '핵심 메모', old9: '옛 요약에 단 메모', blank: '  ' },
};

const paper = (over = {}) => buildPaperNote({ source, digest, notes, citekey: source.id, now: NOW, ...over });
const summary = (over = {}) => buildSummaryNote({
  source, digest, connections: null, researchNoteName: '연구 주제', citekey: source.id, now: NOW, ...over,
});
const between = (md, a, b) => md.slice(md.indexOf(a), b ? md.indexOf(b) : undefined);

test('signalOf maps app colors to the vault stoplight', () => {
  assert.deepEqual(signalOf('#ff6666'), { callout: 'paper-red', label: '🔴 멈춰서 생각' });
  assert.deepEqual(signalOf('#ffd400'), { callout: 'paper-yellow', label: '🟡 천천히 읽기' });
  assert.deepEqual(signalOf('#5fb236'), { callout: 'paper-green', label: '🟢 배경 정보' });
  assert.deepEqual(signalOf('#2ea8e5'), { callout: 'quote', label: 'Blue' });
  assert.deepEqual(signalOf('#123456'), { callout: 'quote', label: '주석' });
});

test('file names: @citekey.md and @citekey 요약.md; papers without Zotero use their id', () => {
  assert.equal(paperNoteFileName(source), '@KimEtAlX2025.md');
  assert.equal(summaryNoteFileName(source), '@KimEtAlX2025 요약.md');
  const folder = { ...source, id: 'folder-paper-1', zotero: undefined };
  assert.equal(paperNoteFileName(folder), 'folder-paper-1.md');
  assert.equal(summaryNoteFileName(folder), 'folder-paper-1 요약.md');
});

// ---------- paper note: only what I marked and wrote ----------

test('paper note: frontmatter and info callout with Zotero link and summary link', () => {
  const md = paper();
  assert.ok(md.startsWith([
    '---',
    'citekey: "KimEtAlX2025"',
    'title: "A Paper Title"',
    'authors: ["Kim A", "Lee \\"B\\""]',
    'year: 2025',
    'doi: "10.1/x"',
    'zotero: "zotero://select/library/items/ITEM0001"',
    'summary: "[[@KimEtAlX2025 요약]]"',
    'tags: [paper]',
    '---',
    BEGIN,
    '# A Paper Title',
    '> [!info] 논문 정보',
    '> 저자: Kim A, Lee "B" · 연도: 2025 · DOI: [10.1/x](https://doi.org/10.1/x)',
    '> 인용: [@KimEtAlX2025] · [Zotero에서 열기](zotero://select/library/items/ITEM0001) · 요약 보기 [[@KimEtAlX2025 요약]]',
    `> 쪽 번호는 PDF 쪽 기준입니다(인쇄된 쪽과 다를 수 있음). 이 칸은 paper-reader에서 보낼 때마다 새로 씁니다(보낸 시각 ${NOW}). 내 글은 맨 아래 "내 생각"에 적으세요.`,
    '',
    '## 하이라이트',
  ].join('\n')), md.slice(0, 900));
  assert.ok(md.trimEnd().endsWith(END));
  assert.equal(md.split(BEGIN).length, 2);
  assert.equal(md.split(END).length, 2);
});

test('paper note: no summary content (takeaway, cards, connections)', () => {
  const md = paper();
  for (const s of ['## 핵심', '## 카드 요약', '핵심 문장이다', '답이다.', '42%', '연구 연결 메모', 'AI 연결점']) assert.ok(!md.includes(s), s);
});

test('paper note: highlights with stoplight colors, sentence order, memos, Zotero annotations', () => {
  const hl = between(paper(), '## 하이라이트', '## 카드에 단 메모');
  // page order: p1 red, p1 blue, p2 yellow, p2 zotero purple, p3 green
  const heads = [...hl.matchAll(/^> \[!(.+?)\] (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(heads, [
    'paper-red 🔴 멈춰서 생각 · p.1',
    'quote Blue · p.1',
    'paper-yellow 🟡 천천히 읽기 · p.2',
    'quote Purple · p.2 (Zotero)',
    'paper-green 🟢 배경 정보 · p.3',
  ]);
  // sentences in document order, marker text neutralized, multi-line memo kept inside the callout
  assert.ok(hl.includes('> [!paper-yellow] 🟡 천천히 읽기 · p.2\n> Page two % % end paper-reader % % text. Page two more.\n>\n> **내 메모:** 천천히\n> 두 줄\n'), hl);
  assert.ok(hl.includes('> [!quote] Purple · p.2 (Zotero)\n> Page two more.\n>\n> **내 메모:** 저테로\n'));
});

test('paper note: card memos by card order, then memos left from an earlier summary', () => {
  const sec = between(paper(), '## 카드에 단 메모', END);
  assert.equal(sec, '## 카드에 단 메모\n- **핵심** — 핵심 메모\n- **왜 필요한가?** — 카드 메모\n  둘째 줄\n\n### 이전 요약의 메모\n- 옛 요약에 단 메모\n');
});

test('paper note: highlight across pages shows a page range', () => {
  const md = paper({ notes: { highlights: [{ id: 'h', sentenceIds: ['p3-s1', 'p2-s2'], color: '#ffd400', comment: '' }] } });
  assert.ok(md.includes('> [!paper-yellow] 🟡 천천히 읽기 · p.2–3\n> Page two more. … Page three.\n'));
});

test('paper note: nothing marked yet → "아직 없습니다." in each section', () => {
  const md = paper({ notes: null });
  assert.ok(md.includes('## 하이라이트\n아직 없습니다.\n\n## 카드에 단 메모\n아직 없습니다.\n'), md);
});

test('paper note: no summary → "요약 없음" instead of the link; memos still listed', () => {
  const md = paper({ digest: null });
  assert.ok(md.includes('summary: "요약 없음"\n'));
  assert.ok(md.includes(' · 요약 없음\n'), md);
  assert.ok(!md.includes('요약]]'));
  assert.ok(md.includes('### 이전 요약의 메모\n- 카드 메모\n  둘째 줄\n'), md);
});

test('paper note: paper without Zotero has no [[@…]] link, citation or Zotero link', () => {
  const src = { ...source, id: 'folder-paper-1', zotero: undefined, meta: { title: 'T' } };
  const md = buildPaperNote({ source: src, digest, notes, citekey: null, now: NOW });
  assert.ok(md.startsWith('---\ncitekey: "folder-paper-1"\ntitle: "T"\nauthors: []\nsummary: "[[folder-paper-1 요약]]"\ntags: [paper]\n---\n'), md.slice(0, 300));
  assert.ok(!md.includes('[[@') && !md.includes('[@') && !md.includes('zotero'));
  assert.ok(md.includes('요약 보기 [[folder-paper-1 요약]]'));
});

// ---------- summary note: what the AI wrote ----------

test('summary note: frontmatter, keyword links, paper link, AI notice', () => {
  const md = summary();
  assert.ok(md.startsWith([
    '---',
    'citekey: "KimEtAlX2025"',
    'paper: "[[@KimEtAlX2025]]"',
    'keywords: ["AIOps", "LLM agent", "fault localization"]',
    'tags: [paper-summary]',
    '---',
    BEGIN,
    '# A Paper Title — 요약',
    '키워드: [[AIOps]] · [[LLM agent]] · [[fault localization]]',
    '논문 노트: [[@KimEtAlX2025]] · 인용 [@KimEtAlX2025]',
    '> [!info] AI가 논문 내용으로 정리한 요약입니다. 연구 연결 메모는 AI가 쓴 연결점이며 논문 내용이 아닙니다. 쪽 번호는 PDF 쪽 기준.',
    `> 이 칸은 paper-reader에서 보낼 때마다 새로 씁니다(보낸 시각 ${NOW}).`,
    '',
    '## 핵심',
    '핵심 문장이다. [@KimEtAlX2025, pp. 1, 3]',
    '> "First sentence." (p.1)',
    '> "Page three." (p.3)',
    '',
  ].join('\n')), md.slice(0, 900));
  assert.ok(md.trimEnd().endsWith(END));
  assert.equal(md.split(BEGIN).length, 2);
  assert.equal(md.split(END).length, 2);
  // what I wrote stays in the paper note
  for (const s of ['## 하이라이트', '내 메모', '카드 메모', '## 내 생각']) assert.ok(!md.includes(s), s);
});

test('summary note: card summaries with claims, bigNumbers and tables', () => {
  const md = summary();
  assert.ok(md.includes('## 카드 요약\n### 1. 왜 필요한가? · 동기\n답이다.\n\n쉬운 설명이다.\n\n- 주장 하나. [@KimEtAlX2025, p. 1]\n  > "Second sentence." (p.1)\n- 주장 둘. [@KimEtAlX2025, pp. 2–3]\n  > "Page two more." (p.2)\n  > "Page three." (p.3)\n'), md);
  assert.ok(md.includes('### 2. 결과는? · 결과\n좋다.\n\ne\n\n- **42%** 정확도 [@KimEtAlX2025, p. 2]\n  > "Page two more." (p.2)\n- 표: 표 1 [@KimEtAlX2025, p. 3]\n  > "Page three." (p.3)\n\n| 모델 | 점수 |\n| --- | --- |\n| A | 1\\|2 |\n'), md);
});

test('quotes join only sentences adjacent in the source; gaps show " … "', () => {
  const src = {
    ...source,
    sentences: {
      'p1-s1': { text: 'One.', page: 1, block: 'b1' },
      'p1-s2': { text: 'Two.', page: 1, block: 'b1' },
      'p1-s3': { text: 'Three.', page: 1, block: 'b2' },
      'p1-s5': { text: 'Five.', page: 1, block: 'b2' },
    },
  };
  const dg = { ...digest, takeaway: { text: 'T.', evidence: ['p1-s5', 'p1-s1', 'p1-s2', 'p1-s3'] }, cards: [] };
  // s1–s2 same block and consecutive → space; s2→s3 new block → gap; s3→s5 skips s4 → gap
  assert.ok(summary({ source: src, digest: dg }).includes('> "One. Two. … Three. … Five." (p.1)\n'));
  const md = paper({ source: src, notes: { highlights: [{ id: 'h', sentenceIds: ['p1-s1', 'p1-s5'], color: '#ffd400', comment: '' }] } });
  assert.ok(md.includes('> [!paper-yellow] 🟡 천천히 읽기 · p.1\n> One. … Five.\n'));
});

test('summary note: connections absent vs present (missing heading flagged)', () => {
  assert.ok(summary().includes('## 연구 연결 메모 (AI가 쓴 연결점 · 논문 내용 아님)\n연결 메모를 아직 만들지 않았습니다.\n'));
  const connections = {
    version: 1, items: [
      { id: 'k1', target: '축 A', text: 'GPU 관리와 이어진다.', evidence: ['p1-s1', 'p2-s2'] },
      { id: 'k2', target: '사라진 제목', text: '연결 둘.', evidence: ['p3-s1', 'zz-s9'] },
    ],
  };
  const sec = between(summary({ connections, researchHeadings: ['축 A', '축 B'] }), '## 연구 연결 메모');
  assert.ok(sec.includes('> [!note] AI 연결점 — [[연구 주제#축 A]]\n> GPU 관리와 이어진다.\n> 근거: "First sentence." (p.1)\n> 근거: "Page two more." (p.2)\n'), sec);
  assert.ok(sec.includes('> [!note] AI 연결점 — 사라진 제목 (연구 노트에서 제목을 찾지 못함)\n> 연결 둘.\n> 근거: "Page three." (p.3)\n'), sec);
  assert.ok(!sec.includes('아직 만들지 않았습니다'));
  const none = summary({ connections: { version: 1, items: [] } });
  assert.ok(none.includes('## 연구 연결 메모 (AI가 쓴 연결점 · 논문 내용 아님)\n연구 주제 노트와 이어지는 내용을 찾지 못했습니다.\n'), none);
});

test('summary note: paper without Zotero links the paper note by id, no citations', () => {
  const src = { ...source, id: 'folder-paper-1', zotero: undefined };
  const md = buildSummaryNote({ source: src, digest, connections: null, researchNoteName: null, citekey: null, now: NOW });
  assert.ok(md.startsWith('---\ncitekey: "folder-paper-1"\npaper: "[[folder-paper-1]]"\n'), md.slice(0, 200));
  assert.ok(md.includes('\n논문 노트: [[folder-paper-1]]\n'));
  assert.ok(!md.includes('[[@') && !md.includes('[@'));
  assert.ok(md.includes('- 주장 하나.\n  > "Second sentence." (p.1)\n'));
});

test('summary note: %% runs never leave a comment opener', () => {
  for (const raw of ['a %% b', 'a %%% b', 'a %%%% b', '%%%%%']) {
    const md = summary({ connections: { version: 1, items: [{ id: 'k', target: 'T', text: raw, evidence: [] }] } });
    const line = between(md, '## 연구 연결 메모').split('\n').find((l) => l.startsWith('> ') && !l.startsWith('> [!'));
    assert.ok(!line.includes('%%'), `${raw} -> ${line}`);
  }
});

// ---------- keywords ----------

test('noteKeywords: digest keywords, else the first glossary terms (≤ 6), else none', () => {
  assert.deepEqual(noteKeywords(digest), ['AIOps', 'LLM agent', 'fault localization']);
  const glossary = Array.from({ length: 8 }, (_, i) => ({ term: `용어 ${i + 1}(term ${i + 1})`, definition: 'd' }));
  assert.deepEqual(noteKeywords({ ...digest, keywords: [], glossary }), glossary.slice(0, 6).map((g) => g.term));
  assert.deepEqual(noteKeywords({ ...digest, keywords: undefined, glossary: [] }), []);
  assert.deepEqual(noteKeywords(null), []);
  const md = summary({ digest: { ...digest, keywords: undefined, glossary: [] } });
  assert.ok(!md.includes('키워드:'), md);
  assert.ok(md.includes('keywords: []\n'));
  assert.ok(md.includes(`${BEGIN}\n# A Paper Title — 요약\n논문 노트: `));
});

test('noteKeywords: link-safe, whitespace-normalized, case-insensitively unique', () => {
  const kw = noteKeywords({ keywords: ['  AIOps ', 'aiops', 'LLM\n  agent', 'a[b]c', 'x|y#z^w', 'TCP/IP', '%%c', '', 42] });
  assert.deepEqual(kw, ['AIOps', 'LLM agent', 'a b c', 'x y z w', 'TCP IP', '% %c']);
  // the same keyword written differently in two papers lands on the same [[link]]
  const a = summary({ digest: { ...digest, keywords: [' AIOps', 'LLM  agent', 'k'] } });
  const b = summary({ digest: { ...digest, keywords: ['AIOps ', 'LLM agent', 'q'] }, source: { ...source, id: 'Other2025' }, citekey: 'Other2025' });
  for (const link of ['[[AIOps]]', '[[LLM agent]]']) assert.ok(a.includes(link) && b.includes(link), link);
});

test('researchHeadings lists headings outside frontmatter and code fences', () => {
  const md = '---\ntitle: x\n# not\n---\n# 제목\ntext\n## 축 A. GPU  \n```\n# code\n```\n### 셋 ###\n#nottag\n';
  assert.deepEqual(researchHeadings(md), ['제목', '축 A. GPU', '셋']);
});

// ---------- merge ----------

const managed = `---\ncitekey: "x"\n---\n${BEGIN}\nNEW\n${END}\n`;

test('mergeManaged: new file gets managed block plus the user section (or none for summary notes)', () => {
  assert.equal(USER_SECTION, '## 내 생각\n\n');
  assert.deepEqual(mergeManaged(null, managed), { text: `${managed}\n## 내 생각\n\n` });
  assert.deepEqual(mergeManaged(null, managed, { userSection: '' }), { text: managed });
});

test('mergeManaged: existing file keeps everything outside the markers byte-identical', () => {
  const existing = `---\ncitekey: "x"\nmine: 1\n---\r\nintro\n${BEGIN}\nOLD\nstuff\n${END}\n\n## 내 생각\n내가 쓴 글 ✍️\r\n`;
  const { text } = mergeManaged(existing, managed);
  assert.equal(text, `---\ncitekey: "x"\nmine: 1\n---\r\nintro\n${BEGIN}\nNEW\n${END}\n\n## 내 생각\n내가 쓴 글 ✍️\r\n`);
});

test('mergeManaged: missing, duplicated or reversed markers → error, no text', () => {
  for (const existing of [
    'no markers',
    `${BEGIN}\nonly begin`,
    `only end\n${END}`,
    `${BEGIN}\n${END}\n${BEGIN}\n${END}`,
    `${END}\nx\n${BEGIN}`,
    '',
  ]) {
    assert.deepEqual(mergeManaged(existing, managed), { error: MARKER_ERROR }, JSON.stringify(existing));
  }
  assert.equal(MARKER_ERROR, 'paper-reader 표시가 깨져 있어 덮어쓰지 않았습니다. 표시를 고치거나 파일을 옮긴 뒤 다시 보내세요.');
});

// ---------- write ----------

async function tmpVault() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-vault-')));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  return { root, vault };
}

test('sanitizeFileName strips forbidden characters and caps length', () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j 읽기 노트.md'), 'abcdefghij 읽기 노트.md');
  assert.equal(sanitizeFileName('..hidden.md'), 'hidden.md');
  assert.equal(sanitizeFileName('x'), 'x.md');
  const long = sanitizeFileName(`${'가'.repeat(300)}.md`);
  assert.equal([...long].length, 150);
  assert.ok(long.endsWith('.md'));
  assert.throws(() => sanitizeFileName('/:*?.md'), /파일 이름/);
});

const pair = (pm = managed, sm = managed.replace('NEW', 'SUM')) => [
  { folder: 'Papers', fileName: '@x.md', managed: pm },
  { folder: 'Summaries', fileName: '@x 요약.md', managed: sm, userSection: '' },
];

test('writeNotes: creates both notes, then re-send replaces only the managed blocks', async () => {
  const { root, vault } = await tmpVault();
  const r = await writeNotes({ vault, notes: pair() });
  assert.deepEqual(r, [{ relPath: 'Papers/@x.md' }, { relPath: 'Summaries/@x 요약.md' }]);
  const pfile = path.join(vault, 'Papers', '@x.md');
  const sfile = path.join(vault, 'Summaries', '@x 요약.md');
  assert.equal(await fs.readFile(pfile, 'utf8'), `${managed}\n## 내 생각\n\n`);
  assert.equal(await fs.readFile(sfile, 'utf8'), managed.replace('NEW', 'SUM'));
  // user edits in Obsidian (both files), then re-sends after the summary was regenerated
  await fs.writeFile(pfile, (await fs.readFile(pfile, 'utf8')).replace('## 내 생각\n', '## 내 생각\n나의 메모\n') + 'tail');
  await fs.writeFile(sfile, `${await fs.readFile(sfile, 'utf8')}\n요약 밖 내 글\n`);
  await writeNotes({ vault, notes: pair(managed.replace('NEW', 'NEWER'), managed.replace('NEW', 'SUM2')) });
  assert.equal(await fs.readFile(pfile, 'utf8'), `${managed.replace('NEW', 'NEWER')}\n## 내 생각\n나의 메모\n\ntail`);
  assert.equal(await fs.readFile(sfile, 'utf8'), `${managed.replace('NEW', 'SUM2')}\n요약 밖 내 글\n`);
  // no temp files left behind
  assert.deepEqual(await fs.readdir(path.join(vault, 'Papers')), ['@x.md']);
  assert.deepEqual(await fs.readdir(path.join(vault, 'Summaries')), ['@x 요약.md']);
  await fs.rm(root, { recursive: true, force: true });
});

test('writeNotes: broken markers in either note → 409 naming that note, neither file written', async () => {
  const { root, vault } = await tmpVault();
  // summary note broken, paper note new: the paper note is not created either (nor its folder)
  await fs.mkdir(path.join(vault, 'Summaries'));
  const sfile = path.join(vault, 'Summaries', '@x 요약.md');
  await fs.writeFile(sfile, 'user only');
  await assert.rejects(writeNotes({ vault, notes: pair() }), (e) => e.status === 409
    && e.message === 'Summaries/@x 요약.md의 paper-reader 표시가 깨져 있어 두 노트 모두 쓰지 않았습니다. 표시를 고치거나 파일을 옮긴 뒤 다시 보내세요.');
  assert.equal(await fs.readFile(sfile, 'utf8'), 'user only');
  await assert.rejects(fs.access(path.join(vault, 'Papers')));
  // paper note broken, summary fine: summary untouched
  await fs.writeFile(sfile, managed);
  await fs.mkdir(path.join(vault, 'Papers'));
  const pfile = path.join(vault, 'Papers', '@x.md');
  await fs.writeFile(pfile, `${BEGIN}\n${BEGIN}\n${END}`);
  await assert.rejects(writeNotes({ vault, notes: pair() }), (e) => e.status === 409 && e.message.startsWith('Papers/@x.md의 '));
  assert.equal(await fs.readFile(sfile, 'utf8'), managed);
  assert.equal(await fs.readFile(pfile, 'utf8'), `${BEGIN}\n${BEGIN}\n${END}`);
  // a single note (no summary) gets the singular wording
  await assert.rejects(writeNotes({ vault, notes: pair().slice(0, 1) }), (e) => e.status === 409
    && e.message === 'Papers/@x.md의 paper-reader 표시가 깨져 있어 노트를 쓰지 않았습니다. 표시를 고치거나 파일을 옮긴 뒤 다시 보내세요.');
  await fs.rm(root, { recursive: true, force: true });
});

test('writeNotes: rejects paths leaving the vault', async () => {
  const { root, vault } = await tmpVault();
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(vault, 'link'));
  const one = (folder, fileName = 'a.md') => writeNotes({ vault, notes: [{ folder, fileName, managed }] });
  for (const folder of ['../outside', 'Notes/../../outside', outside, '/abs', 'link', 'link/sub', '.obsidian', '']) {
    await assert.rejects(one(folder), { status: 400 }, folder);
    // a bad summary folder stops the paper note too
    await assert.rejects(writeNotes({ vault, notes: [{ folder: 'Good', fileName: 'a.md', managed }, { folder, fileName: 'b.md', managed }] }), { status: 400 }, folder);
  }
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.access(path.join(vault, 'Good')));
  // symlinked folder that stays inside the vault is fine
  await fs.mkdir(path.join(vault, 'real'));
  await fs.symlink(path.join(vault, 'real'), path.join(vault, 'inner'));
  assert.deepEqual(await one('inner'), [{ relPath: 'inner/a.md' }]);
  assert.ok((await fs.readFile(path.join(vault, 'real', 'a.md'), 'utf8')).includes('NEW'));
  // a file that is a symlink is never written through, and the other note is not written either
  await fs.writeFile(path.join(outside, 't.md'), `${BEGIN}\n${END}`);
  await fs.symlink(path.join(outside, 't.md'), path.join(vault, 'real', 'b.md'));
  await assert.rejects(writeNotes({ vault, notes: [{ folder: 'real', fileName: 'c.md', managed }, { folder: 'real', fileName: 'b.md', managed }] }), { status: 400 });
  assert.equal(await fs.readFile(path.join(outside, 't.md'), 'utf8'), `${BEGIN}\n${END}`);
  await assert.rejects(fs.access(path.join(vault, 'real', 'c.md')));
  // missing vault
  await assert.rejects(writeNotes({ vault: path.join(root, 'gone'), notes: [{ folder: 'N', fileName: 'a.md', managed }] }), (e) => e.status === 400 && !e.message.includes(root));
  await fs.rm(root, { recursive: true, force: true });
});

test('listVaultNotes lists .md files, skipping hidden folders and symlinks', async () => {
  const { root, vault } = await tmpVault();
  await fs.mkdir(path.join(vault, 'Notes', 'Sub'), { recursive: true });
  await fs.mkdir(path.join(vault, '.obsidian'));
  await fs.writeFile(path.join(vault, '.obsidian', 'x.md'), '');
  await fs.writeFile(path.join(vault, 'Notes', 'b.md'), '');
  await fs.writeFile(path.join(vault, 'Notes', 'Sub', 'a.md'), '');
  await fs.writeFile(path.join(vault, 'top.md'), '');
  await fs.writeFile(path.join(vault, 'img.png'), '');
  await fs.writeFile(path.join(vault, '.hidden.md'), '');
  await fs.symlink(root, path.join(vault, 'loop'));
  assert.deepEqual(await listVaultNotes(vault), { notes: ['Notes/b.md', 'Notes/Sub/a.md', 'top.md'], truncated: false });
  assert.deepEqual(await listVaultNotes(vault, { max: 2 }), { notes: ['Notes/b.md', 'Notes/Sub/a.md'], truncated: true });
  // the companion-note folder is left out, and the cap applies after that
  assert.deepEqual(await listVaultNotes(vault, { exclude: 'Notes/Sub' }), { notes: ['Notes/b.md', 'top.md'], truncated: false });
  assert.deepEqual(await listVaultNotes(vault, { exclude: 'Notes/Sub', max: 2 }), { notes: ['Notes/b.md', 'top.md'], truncated: false });
  assert.deepEqual(await listVaultNotes(vault, { exclude: 'Notes', max: 1 }), { notes: ['top.md'], truncated: false });
  // several folders (paper notes and summary notes) can be left out
  await fs.mkdir(path.join(vault, 'Summaries'));
  await fs.writeFile(path.join(vault, 'Summaries', 's.md'), '');
  assert.deepEqual(await listVaultNotes(vault, { exclude: ['Notes/Sub', 'Summaries'] }), { notes: ['Notes/b.md', 'top.md'], truncated: false });
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- settings ----------

test('validateObsidianSettings checks vault, folder and research note', async () => {
  const { root, vault } = await tmpVault();
  await fs.mkdir(path.join(vault, 'Notes'));
  await fs.writeFile(path.join(vault, 'Notes', '연구.md'), '# 연구');
  await fs.writeFile(path.join(root, 'out.md'), '');
  await fs.symlink(path.join(root, 'out.md'), path.join(vault, 'escape.md'));
  assert.equal(DEFAULT_SUMMARY_FOLDER, 'Summaries');
  assert.deepEqual(await validateObsidianSettings({ vault }), { vault, folder: DEFAULT_FOLDER, summaryFolder: 'Summaries', researchNote: null });
  assert.deepEqual(await validateObsidianSettings({ vault: `${vault}/`, folder: 'A/B/', summaryFolder: 'S/T/', researchNote: 'Notes/연구.md' }),
    { vault, folder: 'A/B', summaryFolder: 'S/T', researchNote: 'Notes/연구.md' });
  assert.equal((await validateObsidianSettings({ vault, summaryFolder: '' })).summaryFolder, 'Summaries');
  const bad = [
    { vault: 'rel' }, { vault: path.join(root, 'gone') }, { vault, folder: '../x' }, { vault, folder: root },
    { vault, researchNote: 'Notes/없음.md' }, { vault, researchNote: '../out.md' }, { vault, researchNote: 'Notes/연구.txt' },
    { vault, researchNote: 'escape.md' }, { vault, researchNote: root + '/out.md' },
    { vault, summaryFolder: '../x' }, { vault, summaryFolder: root }, { vault, summaryFolder: '.obsidian' }, { vault, summaryFolder: 3 },
  ];
  for (const b of bad) await assert.rejects(validateObsidianSettings(b), { status: 400 }, JSON.stringify(b));
  // the folder need not exist yet
  assert.equal((await validateObsidianSettings({ vault, folder: 'New/Dir' })).folder, 'New/Dir');
  await fs.rm(root, { recursive: true, force: true });
});

test('settings: obsidian survives saves of other fields and vice versa', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-set-'));
  const obsidian = { vault: '/v', folder: 'Notes/Papers', researchNote: 'Notes/r.md' };
  await writeSettings(d, { obsidian });
  await writeSettings(d, { agent: 'codex' });
  await writeSettings(d, { folders: [] });
  assert.deepEqual(await readSettings(d), { folders: [], agent: 'codex', obsidian });
  await writeSettings(d, { obsidian: { ...obsidian, researchNote: null } });
  assert.deepEqual((await readSettings(d)).obsidian, { ...obsidian, researchNote: null });
  assert.equal((await readSettings(d)).agent, 'codex');
  await assert.rejects(writeSettings(d, { obsidian: { vault: 3 } }), { status: 400 });
  // the summary folder is stored with the rest; settings saved before it existed read without it
  const two = { ...obsidian, summaryFolder: 'Summaries' };
  await writeSettings(d, { obsidian: two });
  assert.deepEqual((await readSettings(d)).obsidian, two);
  await fs.rm(d, { recursive: true, force: true });
});
