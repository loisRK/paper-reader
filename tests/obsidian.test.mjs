import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BEGIN, END, MARKER_ERROR, buildCompanionNote, mergeManaged, companionFileName, researchHeadings, signalOf,
} from '../src/obsidian/note.mjs';
import { writeCompanionNote, sanitizeFileName, listVaultNotes } from '../src/obsidian/write.mjs';
import { validateObsidianSettings, DEFAULT_FOLDER } from '../src/obsidian/settings.mjs';
import { readSettings, writeSettings } from '../src/library/settings.mjs';

const NOW = '2026-11-20T01:02:03.000Z';
const source = {
  id: 'KimEtAlX2025',
  zotero: { itemKey: 'ITEM0001', attachmentKey: 'ATT00001' },
  meta: { title: 'A  Paper\nTitle', doi: '10.1/x' },
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
  glossary: [],
};
const notes = {
  highlights: [
    { id: 'h1', sentenceIds: ['p2-s2', 'p2-s1'], color: '#ffd400', comment: '천천히\n두 줄' },
    { id: 'h2', sentenceIds: ['p1-s1'], color: '#ff6666', comment: '' },
    { id: 'h3', sentenceIds: ['p3-s1'], color: '#5fb236', comment: '배경' },
    { id: 'h4', sentenceIds: ['p1-s2'], color: '#2ea8e5', comment: '' },
  ],
  zoteroAnnotations: [{ key: 'Z1', page: 2, sentenceIds: ['p2-s2'], text: 'Page two more.', comment: '저테로', color: '#a28ae5' }],
  cardMemos: { c1: '카드 메모\n둘째 줄', takeaway: '핵심 메모' },
};

const build = (over = {}) => buildCompanionNote({
  source, digest, notes, connections: null, researchNoteName: '연구 주제', citekey: source.id, now: NOW, ...over,
});

test('signalOf maps app colors to the vault stoplight', () => {
  assert.deepEqual(signalOf('#ff6666'), { callout: 'paper-red', label: '🔴 멈춰서 생각' });
  assert.deepEqual(signalOf('#ffd400'), { callout: 'paper-yellow', label: '🟡 천천히 읽기' });
  assert.deepEqual(signalOf('#5fb236'), { callout: 'paper-green', label: '🟢 배경 정보' });
  assert.deepEqual(signalOf('#2ea8e5'), { callout: 'quote', label: 'Blue' });
  assert.deepEqual(signalOf('#123456'), { callout: 'quote', label: '주석' });
});

test('companion note: frontmatter, header, takeaway with citation and quotes', () => {
  const md = build();
  assert.ok(md.startsWith(`---\ncitekey: "KimEtAlX2025"\ntitle: "A Paper Title"\nzotero_note: "[[@KimEtAlX2025]]"\npaper_reader: true\nupdated: "${NOW}"\ntags: [paper-reading]\n---\n${BEGIN}\n# A Paper Title — 읽기 노트\n`), md.slice(0, 400));
  assert.match(md, /> \[!info\] 원 노트: \[\[@KimEtAlX2025\]\] · 인용: \[@KimEtAlX2025\] · DOI: \[10\.1\/x\]\(https:\/\/doi\.org\/10\.1\/x\)\n/);
  assert.ok(md.includes('## 핵심\n핵심 문장이다. [@KimEtAlX2025, pp. 1, 3]\n> "First sentence." (p.1)\n> "Page three." (p.3)\n'));
  assert.ok(md.trimEnd().endsWith(END));
  // paper text can never forge a marker
  assert.equal(md.split(BEGIN).length, 2);
  assert.equal(md.split(END).length, 2);
});

test('companion note: card summaries with claims, bigNumbers and tables', () => {
  const md = build();
  assert.ok(md.includes('## 카드 요약\n### 1. 왜 필요한가? · 동기\n답이다.\n\n쉬운 설명이다.\n\n- 주장 하나. [@KimEtAlX2025, p. 1]\n  > "Second sentence." (p.1)\n- 주장 둘. [@KimEtAlX2025, pp. 2–3]\n  > "Page two more." (p.2)\n  > "Page three." (p.3)\n'), md);
  assert.ok(md.includes('### 2. 결과는? · 결과\n좋다.\n\ne\n\n- **42%** 정확도 [@KimEtAlX2025, p. 2]\n  > "Page two more." (p.2)\n- 표: 표 1 [@KimEtAlX2025, p. 3]\n  > "Page three." (p.3)\n\n| 모델 | 점수 |\n| --- | --- |\n| A | 1\\|2 |\n'), md);
});

test('companion note: highlights with stoplight colors, sentence order, memos, Zotero annotations', () => {
  const md = build();
  const hl = md.slice(md.indexOf('## 내 하이라이트·메모'), md.indexOf('## 연구 연결 메모'));
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
  assert.ok(hl.includes('### 카드 메모\n- **핵심**: 핵심 메모\n- **왜 필요한가?**: 카드 메모\n  둘째 줄\n'), hl);
});

test('companion note: highlight across pages shows a page range', () => {
  const md = build({ notes: { highlights: [{ id: 'h', sentenceIds: ['p3-s1', 'p2-s2'], color: '#ffd400', comment: '' }] } });
  assert.ok(md.includes('> [!paper-yellow] 🟡 천천히 읽기 · p.2–3\n> Page two more. … Page three.\n'));
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
  const md = build({ source: src, digest: dg, notes: { highlights: [{ id: 'h', sentenceIds: ['p1-s1', 'p1-s5'], color: '#ffd400', comment: '' }] } });
  // s1–s2 same block and consecutive → space; s2→s3 new block → gap; s3→s5 skips s4 → gap
  assert.ok(md.includes('> "One. Two. … Three. … Five." (p.1)\n'), md);
  assert.ok(md.includes('> [!paper-yellow] 🟡 천천히 읽기 · p.1\n> One. … Five.\n'));
});

test('info callout says page numbers are PDF pages', () => {
  assert.ok(build().includes('> 쪽 번호는 PDF 쪽 기준입니다(인쇄된 쪽과 다를 수 있음).\n'));
});

test('companion note: connections absent vs present (missing heading flagged)', () => {
  assert.ok(build().includes('## 연구 연결 메모 (AI가 쓴 연결점 · 논문 내용 아님)\n연결 메모를 아직 만들지 않았습니다.\n'));
  const connections = {
    version: 1, items: [
      { id: 'k1', target: '축 A', text: 'GPU 관리와 이어진다.', evidence: ['p1-s1', 'p2-s2'] },
      { id: 'k2', target: '사라진 제목', text: '연결 둘.', evidence: ['p3-s1', 'zz-s9'] },
    ],
  };
  const md = build({ connections, researchHeadings: ['축 A', '축 B'] });
  const sec = md.slice(md.indexOf('## 연구 연결 메모'));
  assert.ok(sec.includes('> [!note] AI 연결점 — [[연구 주제#축 A]]\n> GPU 관리와 이어진다.\n> 근거: "First sentence." (p.1)\n> 근거: "Page two more." (p.2)\n'), sec);
  assert.ok(sec.includes('> [!note] AI 연결점 — 사라진 제목 (연구 노트에서 제목을 찾지 못함)\n> 연결 둘.\n> 근거: "Page three." (p.3)\n'), sec);
  assert.ok(!sec.includes('아직 만들지 않았습니다'));
  // generated but nothing related: say so instead of "not created yet"
  const none = build({ connections: { version: 1, items: [] } });
  assert.ok(none.includes('## 연구 연결 메모 (AI가 쓴 연결점 · 논문 내용 아님)\n연구 주제 노트와 이어지는 내용을 찾지 못했습니다.\n'), none);
});

test('companion note: paper without Zotero has no [[@…]] link or pandoc citation', () => {
  const src = { ...source, id: 'folder-paper-1', zotero: undefined };
  const md = buildCompanionNote({ source: src, digest, notes, connections: null, researchNoteName: null, citekey: null, now: NOW });
  assert.ok(md.startsWith('---\ncitekey: "folder-paper-1"\ntitle: "A Paper Title"\npaper_reader: true\n'));
  assert.ok(!md.includes('[[@'));
  assert.ok(!md.includes('[@'));
  assert.ok(md.includes('- 주장 하나.\n  > "Second sentence." (p.1)\n'));
  assert.equal(companionFileName(src), 'folder-paper-1 읽기 노트.md');
  assert.equal(companionFileName(source), '@KimEtAlX2025 읽기 노트.md');
});

test('companion note: no digest → only highlights/memos and a "no summary" line', () => {
  const md = build({ digest: null });
  assert.ok(md.includes('요약이 아직 없습니다.'));
  assert.ok(!md.includes('## 핵심'));
  assert.ok(!md.includes('## 카드 요약'));
  assert.ok(md.includes('## 내 하이라이트·메모'));
  assert.ok(md.includes('- **c1**: 카드 메모'));
  assert.ok(md.includes('## 연구 연결 메모'));
});

test('companion note: empty notes', () => {
  const md = build({ notes: null });
  assert.ok(md.includes('## 내 하이라이트·메모\n하이라이트가 없습니다.\n'));
  assert.ok(!md.includes('### 카드 메모'));
});

test('researchHeadings lists headings outside frontmatter and code fences', () => {
  const md = '---\ntitle: x\n# not\n---\n# 제목\ntext\n## 축 A. GPU  \n```\n# code\n```\n### 셋 ###\n#nottag\n';
  assert.deepEqual(researchHeadings(md), ['제목', '축 A. GPU', '셋']);
});

// ---------- merge ----------

const managed = `---\ncitekey: "x"\n---\n${BEGIN}\nNEW\n${END}\n`;

test('mergeManaged: new file gets managed block plus the user section', () => {
  assert.deepEqual(mergeManaged(null, managed), { text: `${managed}\n## 내 생각\n\n` });
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
  assert.equal(MARKER_ERROR, '짝 노트의 paper-reader 표시가 깨져 있어 덮어쓰지 않았습니다. 표시를 고치거나 파일을 옮긴 뒤 다시 보내세요.');
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

test('writeCompanionNote: creates folder and file, then re-send replaces only the managed block', async () => {
  const { root, vault } = await tmpVault();
  const fileName = '@x 읽기 노트.md';
  const r = await writeCompanionNote({ vault, folder: 'Notes/Papers', fileName, managed });
  assert.deepEqual(r, { relPath: 'Notes/Papers/@x 읽기 노트.md' });
  const file = path.join(vault, 'Notes', 'Papers', fileName);
  assert.equal(await fs.readFile(file, 'utf8'), `${managed}\n## 내 생각\n\n`);
  // user edits in Obsidian, then re-sends
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('## 내 생각\n', '## 내 생각\n나의 메모\n') + 'tail');
  await writeCompanionNote({ vault, folder: 'Notes/Papers', fileName, managed: managed.replace('NEW', 'NEWER') });
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text, `${managed.replace('NEW', 'NEWER')}\n## 내 생각\n나의 메모\n\ntail`);
  // no temp files left behind
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), [fileName]);
  await fs.rm(root, { recursive: true, force: true });
});

test('writeCompanionNote: broken markers → error and file untouched', async () => {
  const { root, vault } = await tmpVault();
  await fs.mkdir(path.join(vault, 'N'));
  const file = path.join(vault, 'N', 'a.md');
  await fs.writeFile(file, 'user only');
  await assert.rejects(writeCompanionNote({ vault, folder: 'N', fileName: 'a.md', managed }), { message: MARKER_ERROR, status: 409 });
  assert.equal(await fs.readFile(file, 'utf8'), 'user only');
  await fs.rm(root, { recursive: true, force: true });
});

test('writeCompanionNote: rejects paths leaving the vault', async () => {
  const { root, vault } = await tmpVault();
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(vault, 'link'));
  for (const folder of ['../outside', 'Notes/../../outside', outside, '/abs', 'link', 'link/sub', '.obsidian', '']) {
    await assert.rejects(writeCompanionNote({ vault, folder, fileName: 'a.md', managed }), { status: 400 }, folder);
  }
  assert.deepEqual(await fs.readdir(outside), []);
  // symlinked folder that stays inside the vault is fine
  await fs.mkdir(path.join(vault, 'real'));
  await fs.symlink(path.join(vault, 'real'), path.join(vault, 'inner'));
  assert.deepEqual(await writeCompanionNote({ vault, folder: 'inner', fileName: 'a.md', managed }), { relPath: 'inner/a.md' });
  assert.ok((await fs.readFile(path.join(vault, 'real', 'a.md'), 'utf8')).includes('NEW'));
  // a file that is a symlink is never written through
  await fs.writeFile(path.join(outside, 't.md'), `${BEGIN}\n${END}`);
  await fs.symlink(path.join(outside, 't.md'), path.join(vault, 'real', 'b.md'));
  await assert.rejects(writeCompanionNote({ vault, folder: 'real', fileName: 'b.md', managed }), { status: 400 });
  assert.equal(await fs.readFile(path.join(outside, 't.md'), 'utf8'), `${BEGIN}\n${END}`);
  // missing vault
  await assert.rejects(writeCompanionNote({ vault: path.join(root, 'gone'), folder: 'N', fileName: 'a.md', managed }), (e) => e.status === 400 && !e.message.includes(root));
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
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- settings ----------

test('validateObsidianSettings checks vault, folder and research note', async () => {
  const { root, vault } = await tmpVault();
  await fs.mkdir(path.join(vault, 'Notes'));
  await fs.writeFile(path.join(vault, 'Notes', '연구.md'), '# 연구');
  await fs.writeFile(path.join(root, 'out.md'), '');
  await fs.symlink(path.join(root, 'out.md'), path.join(vault, 'escape.md'));
  assert.deepEqual(await validateObsidianSettings({ vault }), { vault, folder: DEFAULT_FOLDER, researchNote: null });
  assert.deepEqual(await validateObsidianSettings({ vault: `${vault}/`, folder: 'A/B/', researchNote: 'Notes/연구.md' }),
    { vault, folder: 'A/B', researchNote: 'Notes/연구.md' });
  const bad = [
    { vault: 'rel' }, { vault: path.join(root, 'gone') }, { vault, folder: '../x' }, { vault, folder: root },
    { vault, researchNote: 'Notes/없음.md' }, { vault, researchNote: '../out.md' }, { vault, researchNote: 'Notes/연구.txt' },
    { vault, researchNote: 'escape.md' }, { vault, researchNote: root + '/out.md' },
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
  await fs.rm(d, { recursive: true, force: true });
});

test('companion note: %% runs never leave a comment opener', () => {
  for (const raw of ['a %% b', 'a %%% b', 'a %%%% b', '%%%%%']) {
    const md = build({ connections: { version: 1, items: [{ id: 'k', target: 'T', text: raw, evidence: [] }] } });
    const sec = md.slice(md.indexOf('## 연구 연결 메모'));
    const line = sec.split('\n').find((l) => l.startsWith('> ') && !l.startsWith('> [!'));
    assert.ok(!line.includes('%%'), `${raw} -> ${line}`);
  }
});
