// Obsidian notes per paper — pure builders, no I/O.
// Paper note (`@citekey.md`): what I marked and wrote. Summary note (`@citekey 요약.md`): what the AI made.
// The app owns only the block between BEGIN and END; everything else in either file is the user's.
import { ZOTERO_COLORS } from '../zotero/annotations.mjs';

export const BEGIN = '%% begin paper-reader %%';
export const END = '%% end paper-reader %%';
export const MARKER_ERROR = 'paper-reader 표시가 깨져 있어 덮어쓰지 않았습니다. 표시를 고치거나 파일을 옮긴 뒤 다시 보내세요.';
export const USER_SECTION = '## 내 생각\n\n';
// Frontmatter keys the app rewrites on every export; every other key (tags included) is the user's after creation.
export const PAPER_OWNED_KEYS = ['citekey', 'title', 'authors', 'year', 'doi', 'zotero', 'summary'];
export const SUMMARY_OWNED_KEYS = ['citekey', 'paper', 'keywords'];

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
const noMarks = (s) => s.replace(/%(?=%)/g, '% ');
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
    let t = str(s.text).trim();
    const prev = i > 0 ? sids[i - 1] : null;
    const next = sids[i + 1];
    // The extractor sometimes splits a word hyphenated at a line end into two sentences ("AIOP-" / "SLAB …").
    const hyphenJoin = prev !== null && sentences[prev].page === s.page && seqOf(sid) === seqOf(prev) + 1
      && HYPHEN_END.test(str(sentences[prev].text).trim());
    if (prev !== null) {
      const p = sentences[prev];
      const adjacent = p.page === s.page && (p.block ?? null) === (s.block ?? null) && seqOf(sid) === seqOf(prev) + 1;
      if (hyphenJoin) text = text.replace(/-$/, '');
      else text += adjacent ? ' ' : ' … ';
    }
    if (!hyphenJoin) t = brokenWordBefore(sentences, sid) + t;
    const nextJoined = next !== undefined && sentences[next].page === s.page && seqOf(next) === seqOf(sid) + 1;
    if (!nextJoined) {
      const tail = brokenWordAfter(sentences, sid);
      if (tail) t = t.replace(/-$/, '') + tail;
    }
    text += t;
  });
  return inline(text);
}

const HYPHEN_END = /\p{L}-$/u;
const siblingId = (sid, d) => sid.replace(/-s(\d+)$/, (_, n) => `-s${Number(n) + d}`);
// Start of a word cut off by the previous sentence ("… we use AIOP-" → "AIOP"), or ''.
function brokenWordBefore(sentences, sid) {
  const prev = sentences[siblingId(sid, -1)];
  const t = str(prev?.text).trim();
  if (!prev || prev.page !== sentences[sid].page || !HYPHEN_END.test(t)) return '';
  return (/(\S+)-$/.exec(t)?.[1] ?? '').replace(/^[^\p{L}\p{N}]+/u, '');
}
// Rest of a word this sentence cuts off at its end ("AIOP-" + next "SLAB to …" → "SLAB"), or ''.
function brokenWordAfter(sentences, sid) {
  if (!HYPHEN_END.test(str(sentences[sid].text).trim())) return '';
  const next = sentences[siblingId(sid, 1)];
  if (!next || next.page !== sentences[sid].page) return '';
  return (/^\S+/.exec(str(next.text).trim())?.[0] ?? '').replace(/[^\p{L}\p{N}]+$/u, '');
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

/** Paper note file name: `@<citekey>.md` for Zotero papers, else `<id>.md`. */
export function paperNoteFileName(source) {
  return `${paperNoteName(source)}.md`;
}

/** Summary note file name: `@<citekey> 요약.md` for Zotero papers, else `<id> 요약.md`. */
export function summaryNoteFileName(source) {
  return `${summaryNoteName(source)}.md`;
}

// Link targets (file names without .md). Same sanitizing as the file name so the links resolve.
const paperNoteName = (source) => (source?.zotero?.itemKey ? `@${source.id}` : `${source?.id ?? ''}`);
const summaryNoteName = (source) => `${paperNoteName(source)} 요약`;

// Obsidian link targets cannot contain these.
const linkPart = (s) => inline(s).replace(/[[\]|#^]/g, ' ').replace(/\s+/g, ' ').trim();
// Keyword links name a note file, so file-name characters are dropped too (`TCP/IP` would be a folder path).
const keywordPart = (s) => linkPart(str(s).normalize('NFC')).replace(/[\\/:*?"<>]/g, ' ').replace(/\s+/g, ' ').trim();

const MAX_KEYWORDS = 6;
const MAX_KEYWORD_LEN = 40;

/**
 * Keywords for the summary note's [[links]]: digest.keywords, or (older digests without them) the first
 * glossary terms. Whitespace-normalized and link-safe, so the same term in two papers gives the same link;
 * duplicates (ignoring case) are dropped.
 */
export function noteKeywords(digest) {
  const own = Array.isArray(digest?.keywords) ? digest.keywords : [];
  const fromGlossary = (Array.isArray(digest?.glossary) ? digest.glossary : []).map((g) => g?.term);
  const out = [];
  const seen = new Set();
  for (const raw of own.some((k) => keywordPart(k)) ? own : fromGlossary) {
    const k = keywordPart(raw);
    if (!k || [...k].length > MAX_KEYWORD_LEN || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

const q = (v) => JSON.stringify(v);
const stamp = (now) => (now instanceof Date ? now.toISOString() : str(now) || new Date().toISOString());
const sentencesOf = (source) => (source?.sentences && typeof source.sentences === 'object' ? source.sentences : {});
const titleOf = (source) => inline(source?.meta?.title) || inline(source?.id);
function yearOf(meta) {
  if (Number.isInteger(meta?.year)) return meta.year;
  const m = /^(\d{4})/.exec(str(meta?.year) || str(meta?.date));
  return m ? Number(m[1]) : null;
}
const zoteroLink = (source) => (source?.zotero?.itemKey ? `zotero://select/library/items/${encodeURIComponent(source.zotero.itemKey)}` : null);

/**
 * Paper note: what I marked and wrote — highlights (app and Zotero), their memos and card memos.
 * No summary content. Builds frontmatter + the managed block (BEGIN…END), ending with "\n".
 * citekey: the Zotero citekey, or null for a paper not in Zotero (no [@…] citation, no Zotero link).
 * hasSummary: whether a summary note is written next to it (default: a digest exists).
 */
export function buildPaperNote({ source, digest, notes, citekey, now, hasSummary = Boolean(digest) }) {
  const sentences = sentencesOf(source);
  const id = source?.id ?? '';
  const meta = source?.meta ?? {};
  const title = titleOf(source);
  const doi = inline(meta.doi);
  const authors = (Array.isArray(meta.authors) ? meta.authors : []).map(inline).filter(Boolean);
  const year = yearOf(meta);
  const zotero = zoteroLink(source);
  const summaryLink = hasSummary ? `[[${summaryNoteName(source)}]]` : null;
  const at = stamp(now);
  const L = [];

  L.push('---', `citekey: ${q(citekey ?? id)}`, `title: ${q(title)}`, `authors: [${authors.map(q).join(', ')}]`);
  if (year) L.push(`year: ${year}`);
  if (doi) L.push(`doi: ${q(doi)}`);
  if (zotero) L.push(`zotero: ${q(zotero)}`);
  L.push(`summary: ${q(summaryLink ?? '요약 없음')}`, 'tags: [paper]', '---');

  L.push(BEGIN, `# ${title}`, '> [!info] 논문 정보');
  const facts = [];
  if (authors.length) facts.push(`저자: ${authors.join(', ')}`);
  if (year) facts.push(`연도: ${year}`);
  if (doi) facts.push(`DOI: [${doi}](https://doi.org/${encodeURI(doi)})`);
  if (!citekey) facts.push(`논문 id: ${inline(id)}`);
  if (facts.length) L.push(`> ${facts.join(' · ')}`);
  const links = [];
  if (citekey) links.push(`인용: [@${citekey}]`);
  if (zotero) links.push(`[Zotero에서 열기](${zotero})`);
  links.push(summaryLink ? `요약 보기 ${summaryLink}` : '요약 없음');
  L.push(`> ${links.join(' · ')}`);
  L.push(`> 쪽 번호는 PDF 쪽 기준입니다(인쇄된 쪽과 다를 수 있음). 이 칸은 paper-reader에서 보낼 때마다 새로 씁니다(보낸 시각 ${at}). 내 글은 맨 아래 "내 생각"에 적으세요.`, '');

  L.push('## 하이라이트');
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
  if (!marks.length) L.push('아직 없습니다.', '');
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

  L.push('## 카드에 단 메모');
  const cards = Array.isArray(digest?.cards) ? digest.cards : [];
  const memos = notes?.cardMemos && typeof notes.cardMemos === 'object' ? notes.cardMemos : {};
  const memoIds = Object.keys(memos).filter((k) => str(memos[k]).trim());
  const order = ['takeaway', ...cards.map((c) => c.id)];
  // Memos whose card is gone (the summary was regenerated with new cards), as the paper view shows them.
  const current = memoIds.filter((k) => order.includes(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const old = memoIds.filter((k) => !order.includes(k));
  if (!current.length && !old.length) L.push('아직 없습니다.');
  for (const k of current) {
    const card = cards.find((c) => c.id === k);
    const name = k === 'takeaway' ? '핵심' : inline(card?.question) || inline(k);
    const [first, ...rest] = lines(memos[k]);
    L.push(`- **${name}** — ${first}`, ...rest.map((r) => `  ${r}`));
  }
  if (old.length) {
    if (current.length) L.push('');
    L.push('### 이전 요약의 메모');
    for (const k of old) {
      const [first, ...rest] = lines(memos[k]);
      L.push(`- ${first}`, ...rest.map((r) => `  ${r}`));
    }
  }
  L.push(END);
  return `${L.join('\n')}\n`;
}

/**
 * Summary note: what the AI made — takeaway, card summaries and research-connection notes — with keyword links.
 * Builds frontmatter + the managed block (BEGIN…END), ending with "\n". Only for a paper with a digest.
 * researchHeadings: current headings of the research note, or null to skip the check.
 */
export function buildSummaryNote({ source, digest, connections, researchNoteName, citekey, now, researchHeadings: headings = null }) {
  const sentences = sentencesOf(source);
  const id = source?.id ?? '';
  const title = titleOf(source);
  const keywords = noteKeywords(digest);
  const paperLink = `[[${paperNoteName(source)}]]`;
  const at = stamp(now);
  const cite = (sids) => {
    if (!citekey) return '';
    const pages = pagesOf(sentences, sids);
    return pages.length ? ` [@${citekey}, ${locator(pages)}]` : ` [@${citekey}]`;
  };
  const L = [];

  L.push('---', `citekey: ${q(citekey ?? id)}`, `paper: ${q(paperLink)}`, `keywords: [${keywords.map(q).join(', ')}]`, 'tags: [paper-summary]', '---');
  L.push(BEGIN, `# ${title} — 요약`);
  if (keywords.length) L.push(`키워드: ${keywords.map((k) => `[[${k}]]`).join(' · ')}`);
  L.push(`논문 노트: ${paperLink}${citekey ? ` · 인용 [@${citekey}]` : ''}`);
  L.push('> [!info] AI가 논문 내용으로 정리한 요약입니다. 연구 연결 메모는 AI가 쓴 연결점이며 논문 내용이 아닙니다. 쪽 번호는 PDF 쪽 기준.');
  L.push(`> 이 칸은 paper-reader에서 보낼 때마다 새로 씁니다(보낸 시각 ${at}).`, '');

  const tk = digest?.takeaway;
  if (tk?.text) {
    const ev = known(sentences, tk.evidence);
    L.push('## 핵심', `${para(tk.text)}${cite(ev)}`, ...quoteLines(sentences, ev, '> '), '');
  }
  const cards = Array.isArray(digest?.cards) ? digest.cards : [];
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

  L.push('## 연구 연결 메모 (AI가 쓴 연결점 · 논문 내용 아님)');
  const items = Array.isArray(connections?.items) ? connections.items : [];
  if (!items.length) {
    L.push(Array.isArray(connections?.items) ? '연구 주제 노트와 이어지는 내용을 찾지 못했습니다.' : '연결 메모를 아직 만들지 않았습니다.');
  }
  const noteName = linkPart(researchNoteName ?? '');
  for (const it of items) {
    const target = inline(it?.target);
    const found = !Array.isArray(headings) || headings.includes(str(it?.target).trim());
    const where = !found ? `${target} (연구 노트에서 제목을 찾지 못함)`
      : noteName ? `[[${noteName}#${linkPart(target)}]]` : target;
    const ev = known(sentences, it?.evidence);
    L.push(`> [!note] AI 연결점 — ${where}`, `> ${inline(it?.text)}`, ...quoteLines(sentences, ev, '> 근거: '), '');
  }
  if (L.at(-1) === '') L.pop();
  L.push(END);
  return `${L.join('\n')}\n`;
}

const count = (s, sub) => s.split(sub).length - 1;

// ---------- frontmatter ----------

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]|$)/;

// Leading `---` block of `text`: { eol, start, end, lines } (lines between the fences, without EOLs), or null.
function frontmatter(text) {
  const m = /^---(\r?\n)/.exec(text);
  if (!m) return null;
  const eol = m[1];
  const lines = [];
  let pos = m[0].length;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl < 0 ? text.length : nl + 1;
    const line = text.slice(pos, nl < 0 ? text.length : nl).replace(/\r$/, '');
    if (line === '---' || line === '...') return { eol, start: m[0].length, end: pos, lines };
    lines.push(line);
    pos = next;
  }
  return null;
}

// A quoted scalar that does not close on its own line continues on the next ones; we do not follow those.
const openQuote = (v) => (v.startsWith('"') && !/^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(v))
  || (v.startsWith("'") && !/^'(?:[^']|'')*'\s*(?:#.*)?$/.test(v));
// `"title": x` or `title : x` — a key we would not recognise, so we could duplicate it.
const ODD_KEY = /^(?:["'][^"']*["']|[A-Za-z_][\w-]*[ \t]+)[ \t]*:/;

/**
 * Top-level entries of a frontmatter: a `key:` line plus its value lines — indented lines and `- ` items, with any
 * blank or comment lines between them. Blank/comment lines after the last value line stand alone (they are the
 * user's). Returns null when the block cannot be read safely: an unterminated quote, an unrecognised key form,
 * a line that belongs to no key, or a `- ` item after a block scalar.
 */
function entries(lines) {
  const out = [];
  let cur = null;
  let pending = [];
  const flush = () => {
    if (cur) out.push(cur);
    out.push(...pending.map((l) => ({ key: null, lines: [l] })));
    cur = null;
    pending = [];
  };
  for (const line of lines) {
    const k = KEY_LINE.exec(line);
    if (k) {
      flush();
      const value = line.slice(k[0].length).trim();
      if (openQuote(value)) return null;
      cur = { key: k[1], lines: [line], block: /^[|>]/.test(value) };
      continue;
    }
    if (ODD_KEY.test(line)) return null;
    if (line.trim() === '' || /^[ \t]*#/.test(line)) {
      if (cur) pending.push(line);
      else out.push({ key: null, lines: [line] });
      continue;
    }
    const indented = /^[ \t]/.test(line);
    const item = line === '-' || line.startsWith('- ');
    if (!cur || !(indented || (item && !cur.block))) return null;
    cur.lines.push(...pending, line);
    pending = [];
  }
  flush();
  return out;
}

/**
 * Rewrites the owned keys of `head` (the text before BEGIN) with their lines from `fresh` (the new frontmatter):
 * replaced in place, missing ones appended at the end of the block. Everything else stays byte-identical.
 * No parsable frontmatter in either → `head` unchanged.
 */
function mergeFrontmatter(head, fresh, ownedKeys) {
  if (!ownedKeys.length) return head;
  const old = frontmatter(head);
  const neu = frontmatter(fresh);
  if (!old || !neu) return head;
  const oldEntries = entries(old.lines);
  const neuEntries = entries(neu.lines);
  if (!oldEntries || !neuEntries) return head;
  const want = new Map(neuEntries.filter((e) => e.key && ownedKeys.includes(e.key)).map((e) => [e.key, e.lines]));
  const done = new Set();
  const lines = [];
  for (const e of oldEntries) {
    if (e.key && want.has(e.key)) {
      if (!done.has(e.key)) lines.push(...want.get(e.key));
      done.add(e.key);
    } else if (!(e.key && ownedKeys.includes(e.key))) {
      lines.push(...e.lines); // an owned key the app no longer emits (e.g. a removed DOI) is dropped
    }
  }
  for (const [k, v] of want) if (!done.has(k)) lines.push(...v);
  const body = lines.map((l) => `${l}${old.eol}`).join('');
  return head.slice(0, old.start) + body + head.slice(old.end);
}

/**
 * new file (existing === null) → managed + the user section ('' for summary notes: markers only).
 * existing file → BEGIN…END is replaced, and the frontmatter lines of `ownedKeys` are rewritten;
 * every other byte outside stays as it was.
 * Missing, repeated or reversed markers → { error } (never overwrite).
 */
export function mergeManaged(existing, managed, { userSection = USER_SECTION, ownedKeys = [] } = {}) {
  const mb = managed.indexOf(BEGIN);
  const me = managed.indexOf(END);
  if (mb < 0 || me < mb) throw new Error('managed 텍스트에 paper-reader 표시가 없습니다.');
  if (existing === null || existing === undefined) {
    const base = managed.endsWith('\n') ? managed : `${managed}\n`;
    return { text: userSection ? `${base}\n${userSection}` : base };
  }
  if (count(existing, BEGIN) !== 1 || count(existing, END) !== 1) return { error: MARKER_ERROR };
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (e < b) return { error: MARKER_ERROR };
  const block = managed.slice(mb, me + END.length);
  const head = mergeFrontmatter(existing.slice(0, b), managed.slice(0, mb), ownedKeys);
  return { text: head + block + existing.slice(e + END.length) };
}
