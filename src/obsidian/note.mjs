// Obsidian "짝 노트"(companion reading note) — pure builders, no I/O.
// The app owns only the block between BEGIN and END; everything else in the file is the user's.
import { ZOTERO_COLORS } from '../zotero/annotations.mjs';

export const BEGIN = '%% begin paper-reader %%';
export const END = '%% end paper-reader %%';
export const MARKER_ERROR = '짝 노트의 paper-reader 표시가 깨져 있어 덮어쓰지 않았습니다. 표시를 고치거나 파일을 옮긴 뒤 다시 보내세요.';
export const USER_SECTION = '## 내 생각\n\n';

const SECTION_LABELS = {
  motivation: '동기', gap: '빈틈(Gap)', idea: '아이디어', method: '방법', setup: '실험 설정',
  results: '결과', analysis: '분석', limits: '한계', implications: '시사점',
};

// Same stoplight as the vault's Zotero-Literature template (callouts styled by paper-stoplight.css).
const SIGNALS = {
  red: { callout: 'paper-red', label: '🔴 멈춰서 생각' },
  yellow: { callout: 'paper-yellow', label: '🟡 천천히 읽기' },
  green: { callout: 'paper-green', label: '🟢 배경 정보' },
};
const NAME_OF_HEX = new Map(Object.entries(ZOTERO_COLORS).map(([name, hex]) => [hex.toLowerCase(), name]));

export function signalOf(color) {
  const name = NAME_OF_HEX.get(String(color ?? '').toLowerCase());
  if (!name) return { callout: 'quote', label: '주석' };
  return SIGNALS[name] ?? { callout: 'quote', label: name[0].toUpperCase() + name.slice(1) };
}

// ---------- text helpers ----------

const str = (v) => (typeof v === 'string' ? v : '');
// `%%` would open an Obsidian comment or forge a marker, so it never reaches the note as-is.
const noMarks = (s) => s.replace(/%%/g, '% %');
const inline = (v) => noMarks(str(v).replace(/\s+/g, ' ').trim());
// A paragraph line must not turn into a heading, quote or list by accident.
const para = (v) => inline(v).replace(/^([#>|+*-])/, '\\$1');
const lines = (v) => noMarks(str(v).replace(/\r\n?/g, '\n').trim()).split('\n');
const cell = (v) => inline(v).replace(/\|/g, '\\|');

const seqOf = (sid) => Number(/-s(\d+)$/.exec(sid)?.[1] ?? Infinity);

function known(sentences, sids) {
  const list = Array.isArray(sids) ? sids.filter((s) => typeof s === 'string' && Object.hasOwn(sentences, s)) : [];
  return [...new Set(list)].sort((a, b) => (sentences[a].page ?? 0) - (sentences[b].page ?? 0) || seqOf(a) - seqOf(b));
}

const pageRange = (pages) => (pages.length === 0 ? '' : pages[0] === pages.at(-1) ? `${pages[0]}` : `${pages[0]}–${pages.at(-1)}`);
const pagesOf = (sentences, sids) => [...new Set(sids.map((s) => sentences[s].page).filter(Number.isFinite))].sort((a, b) => a - b);

// Pandoc locator: p. 2 / pp. 2–3 (consecutive) / pp. 1, 10
function locator(pages) {
  if (pages.length === 1) return `p. ${pages[0]}`;
  const consecutive = pages.every((p, i) => i === 0 || p === pages[i - 1] + 1);
  return consecutive ? `pp. ${pages[0]}–${pages.at(-1)}` : `pp. ${pages.join(', ')}`;
}

// Sentences adjacent in the source (same page and block, consecutive sequence numbers) join with a space;
// any gap is shown as " … " so no quote reads as a continuous passage that the paper does not contain.
function joinSentences(sentences, sids) {
  let text = '';
  sids.forEach((sid, i) => {
    const s = sentences[sid];
    if (i > 0) {
      const p = sentences[sids[i - 1]];
      const adjacent = p.page === s.page && (p.block ?? null) === (s.block ?? null) && seqOf(sid) === seqOf(sids[i - 1]) + 1;
      text += adjacent ? ' ' : ' … ';
    }
    text += str(s.text);
  });
  return inline(text);
}

// One quote line per page, sentences in reading order.
function quoteLines(sentences, sids, prefix) {
  const out = [];
  let cur = null;
  for (const sid of sids) {
    const page = sentences[sid].page;
    if (cur && cur.page === page) cur.sids.push(sid);
    else out.push(cur = { page, sids: [sid] });
  }
  return out.map((g) => `${prefix}"${joinSentences(sentences, g.sids)}" (p.${g.page})`);
}

/** Headings (#..######) of a Markdown note, outside frontmatter and code fences. */
export function researchHeadings(markdown) {
  const out = [];
  const rows = str(markdown).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (rows[0] === '---') {
    const end = rows.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  let fence = null;
  for (; i < rows.length; i += 1) {
    const row = rows[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(row);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^#{1,6}[ \t]+(.*?)[ \t]*(?:#+[ \t]*)?$/.exec(row);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/** File name of the companion note: `@<citekey> 읽기 노트.md` for Zotero papers, else `<id> 읽기 노트.md`. */
export function companionFileName(source) {
  return source?.zotero?.itemKey ? `@${source.id} 읽기 노트.md` : `${source.id} 읽기 노트.md`;
}

// Obsidian link targets cannot contain these.
const linkPart = (s) => inline(s).replace(/[[\]|#^]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Builds frontmatter + the managed block (BEGIN…END), ending with "\n".
 * citekey: the Zotero citekey, or null for a paper not in Zotero (no [[@…]] link, no [@…] citation).
 * researchHeadings: current headings of the research note, or null to skip the check.
 */
export function buildCompanionNote({ source, digest, notes, connections, researchNoteName, citekey, now, researchHeadings: headings = null }) {
  const sentences = source?.sentences && typeof source.sentences === 'object' ? source.sentences : {};
  const id = source?.id ?? '';
  const title = inline(source?.meta?.title) || id;
  const doi = inline(source?.meta?.doi);
  const at = now instanceof Date ? now.toISOString() : str(now) || new Date().toISOString();
  const cite = (sids) => {
    if (!citekey) return '';
    const pages = pagesOf(sentences, sids);
    return pages.length ? ` [@${citekey}, ${locator(pages)}]` : ` [@${citekey}]`;
  };
  const L = [];

  L.push('---', `citekey: ${JSON.stringify(citekey ?? id)}`, `title: ${JSON.stringify(title)}`);
  if (citekey) L.push(`zotero_note: ${JSON.stringify(`[[@${citekey}]]`)}`);
  L.push('paper_reader: true', `updated: ${JSON.stringify(at)}`, 'tags: [paper-reading]', '---');

  L.push(BEGIN, `# ${title} — 읽기 노트`);
  const info = citekey ? [`원 노트: [[@${citekey}]]`, `인용: [@${citekey}]`] : [`논문 id: ${inline(id)}`];
  if (doi) info.push(`DOI: [${doi}](https://doi.org/${encodeURI(doi)})`);
  L.push(`> [!info] ${info.join(' · ')}`);
  L.push(`> 이 칸은 paper-reader에서 보낼 때마다 새로 씁니다(보낸 시각 ${at}). 내 글은 맨 아래 "내 생각"에 적으세요.`);
  L.push('> 쪽 번호는 PDF 쪽 기준입니다(인쇄된 쪽과 다를 수 있음).', '');

  const cards = Array.isArray(digest?.cards) ? digest.cards : [];
  if (!digest) {
    L.push('요약이 아직 없습니다.', '');
  } else {
    const tk = digest.takeaway;
    if (tk?.text) {
      const ev = known(sentences, tk.evidence);
      L.push('## 핵심', `${para(tk.text)}${cite(ev)}`, ...quoteLines(sentences, ev, '> '), '');
    }
    if (cards.length) {
      L.push('## 카드 요약');
      cards.forEach((c, i) => {
        const section = SECTION_LABELS[c.section] ?? inline(c.section);
        L.push(`### ${i + 1}. ${inline(c.question)}${section ? ` · ${section}` : ''}`);
        if (inline(c.answer)) L.push(para(c.answer));
        if (inline(c.explain)) L.push('', para(c.explain), '');
        for (const it of c.items ?? []) {
          const ev = known(sentences, it.evidence);
          L.push(`- ${inline(it.text)}${cite(ev)}`, ...quoteLines(sentences, ev, '  > '));
        }
        for (const bn of c.bigNumbers ?? []) {
          const ev = known(sentences, bn.evidence);
          L.push(`- **${inline(bn.value)}** ${inline(bn.label)}${cite(ev)}`, ...quoteLines(sentences, ev, '  > '));
        }
        for (const t of c.tables ?? []) {
          const ev = known(sentences, t.evidence);
          L.push(`- 표: ${inline(t.title)}${cite(ev)}`, ...quoteLines(sentences, ev, '  > '), '');
          L.push(`| ${t.columns.map(cell).join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`);
          for (const r of t.rows) L.push(`| ${r.map(cell).join(' | ')} |`);
          if (inline(t.note)) L.push('', para(t.note));
        }
        L.push('');
      });
    }
  }

  L.push('## 내 하이라이트·메모');
  const marks = [];
  for (const h of Array.isArray(notes?.highlights) ? notes.highlights : []) {
    const sids = known(sentences, h?.sentenceIds);
    if (sids.length) marks.push({ sids, text: joinSentences(sentences, sids), color: h.color, comment: h.comment, zotero: false });
  }
  for (const a of Array.isArray(notes?.zoteroAnnotations) ? notes.zoteroAnnotations : []) {
    const sids = known(sentences, a?.sentenceIds);
    const text = sids.length ? null : str(a?.text);
    if (!sids.length && !text) continue;
    marks.push({ sids, text: sids.length ? joinSentences(sentences, sids) : inline(text), page: a.page, color: a.color, comment: a.comment, zotero: true });
  }
  const firstPage = (m) => (m.sids.length ? sentences[m.sids[0]].page : Number.isFinite(m.page) ? m.page : Infinity);
  const firstSeq = (m) => (m.sids.length ? seqOf(m.sids[0]) : Infinity);
  marks.sort((x, y) => firstPage(x) - firstPage(y) || firstSeq(x) - firstSeq(y) || Number(x.zotero) - Number(y.zotero));
  if (!marks.length) L.push('하이라이트가 없습니다.', '');
  for (const m of marks) {
    const { callout, label } = signalOf(m.color);
    const pages = m.sids.length ? pagesOf(sentences, m.sids) : Number.isFinite(m.page) ? [m.page] : [];
    const where = pages.length ? ` · p.${pageRange(pages)}` : '';
    L.push(`> [!${callout}] ${label}${where}${m.zotero ? ' (Zotero)' : ''}`, `> ${m.text}`);
    if (str(m.comment).trim()) {
      const [first, ...rest] = lines(m.comment);
      L.push('>', `> **내 메모:** ${first}`, ...rest.map((r) => `> ${r}`));
    }
    L.push('');
  }

  const memos = notes?.cardMemos && typeof notes.cardMemos === 'object' ? notes.cardMemos : {};
  const memoIds = Object.keys(memos).filter((k) => str(memos[k]).trim());
  if (memoIds.length) {
    const order = ['takeaway', ...cards.map((c) => c.id)];
    const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
    memoIds.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    L.push('### 카드 메모');
    for (const k of memoIds) {
      const card = cards.find((c) => c.id === k);
      const name = k === 'takeaway' ? '핵심' : card ? inline(card.question) || k : inline(k);
      const [first, ...rest] = lines(memos[k]);
      L.push(`- **${name}**: ${first}`, ...rest.map((r) => `  ${r}`));
    }
    L.push('');
  }

  L.push('## 연구 연결 메모 (AI가 쓴 연결점 · 논문 내용 아님)');
  const items = Array.isArray(connections?.items) ? connections.items : [];
  if (!items.length) L.push('연결 메모를 아직 만들지 않았습니다.');
  const noteName = linkPart(researchNoteName ?? '');
  for (const it of items) {
    const target = inline(it?.target);
    const found = !Array.isArray(headings) || headings.includes(str(it?.target).trim());
    const where = !found ? `${target} (연구 노트에서 제목을 찾지 못함)`
      : noteName ? `[[${noteName}#${linkPart(target)}]]` : target;
    const ev = known(sentences, it?.evidence);
    L.push(`> [!note] ${inline(it?.text)} — 연결 대상: ${where}`, ...quoteLines(sentences, ev, '> 근거: '), '');
  }
  if (L.at(-1) === '') L.pop();
  L.push(END);
  return `${L.join('\n')}\n`;
}

const count = (s, sub) => s.split(sub).length - 1;

/**
 * new file (existing === null) → managed + the user section.
 * existing file → only BEGIN…END is replaced; every byte outside stays as it was.
 * Missing, repeated or reversed markers → { error } (never overwrite).
 */
export function mergeManaged(existing, managed) {
  const mb = managed.indexOf(BEGIN);
  const me = managed.indexOf(END);
  if (mb < 0 || me < mb) throw new Error('managed 텍스트에 paper-reader 표시가 없습니다.');
  if (existing === null || existing === undefined) {
    return { text: `${managed.endsWith('\n') ? managed : `${managed}\n`}\n${USER_SECTION}` };
  }
  if (count(existing, BEGIN) !== 1 || count(existing, END) !== 1) return { error: MARKER_ERROR };
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (e < b) return { error: MARKER_ERROR };
  const block = managed.slice(mb, me + END.length);
  return { text: existing.slice(0, b) + block + existing.slice(e + END.length) };
}
