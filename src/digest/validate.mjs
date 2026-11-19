export const SECTIONS = ['motivation', 'gap', 'idea', 'method', 'setup', 'results', 'analysis', 'limits', 'implications'];

// Coverage floor: a digest must carry the whole paper, not just the abstract (prompts/digest.md 4·7절).
const MIN_CARDS = 12;
const MIN_CARDS_SHORT = 8;
const SHORT_PAPER_PAGES = 6;
const CLAIM_MAX = 100;
const EXPLAIN_MIN_SENTENCES = 2;

/** Minimum number of cards for this paper: 8 for short papers (≤ 6 pages), else 12. */
export function minCards(source) {
  const pages = Array.isArray(source?.pages) ? source.pages.length : 0;
  return pages > 0 && pages <= SHORT_PAPER_PAGES ? MIN_CARDS_SHORT : MIN_CARDS;
}

/**
 * Counts sentences ending in . ! ? 。 (Korean "다." and English "." alike) or a line break.
 * A period followed by a digit (13.9%) is not a break; fragments without letters/digits are ignored.
 */
export function sentenceCount(text) {
  if (typeof text !== 'string') return 0;
  return text.split(/(?<=[.!?。])(?!\d)|\n+/u).filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// Pure and total: never throws, never mutates `digest`.
export function validateDigest(digest, source) {
  const paperId = source?.id;
  const empty = { version: 1, paperId, takeaway: null, cards: [], glossary: [] };
  if (!isObj(digest) || !Array.isArray(digest.cards)) {
    return { digest: empty, problems: ['digest.json 형식이 올바르지 않습니다'] };
  }
  const problems = [];
  const sentences = isObj(source?.sentences) ? source.sentences : {};
  const pageCount = Array.isArray(source?.pages) ? source.pages.length : 0;
  const known = (id) => Object.hasOwn(sentences, id);
  const allKnown = (ev) => ev.length > 0 && ev.every(known);

  let takeaway = null;
  if (isObj(digest.takeaway)) {
    const ev = strList(digest.takeaway.evidence);
    takeaway = { text: str(digest.takeaway.text), evidence: ev.filter(known), why: str(digest.takeaway.why) };
    if (!allKnown(ev)) problems.push('takeaway: 근거 확인 필요 – evidence가 없거나 source.json에 없는 문장 ID가 있습니다');
  } else {
    problems.push('takeaway: 없음 – 0번 Takeaway를 작성하세요');
  }

  // Card ids key reading progress, so they must be unique. Ids as written are reserved first;
  // a repeated id gets the next free "<id>-N".
  const rawId = (c, idx) => (isObj(c) ? str(c.id) : '') || `c${idx + 1}`;
  const taken = new Set(digest.cards.map(rawId));
  const used = new Set();

  const cards = [];
  digest.cards.forEach((c, idx) => {
    if (!isObj(c)) {
      problems.push(`c${idx + 1}: 카드 형식이 올바르지 않아 제거`);
      return;
    }
    let id = rawId(c, idx);
    if (used.has(id)) {
      problems.push(`${id}: 카드 id 중복`);
      let n = 2;
      while (taken.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
      taken.add(id);
    }
    used.add(id);
    const section = str(c.section);
    if (!SECTIONS.includes(section)) problems.push(`${id}: 알 수 없는 section "${section}"`);
    const head = (t) => str(t).slice(0, 30);

    const items = [];
    for (const it of Array.isArray(c.items) ? c.items : []) {
      if (!isObj(it)) continue;
      const ev = strList(it.evidence);
      if (it.kind === 'claim') {
        if (!allKnown(ev)) {
          problems.push(`${id}: 근거 없는 claim 제거 – ${head(it.text)}`);
          continue;
        }
        items.push({ kind: 'claim', label: str(it.label), text: str(it.text), evidence: ev });
        const len = [...str(it.text)].length;
        if (len > CLAIM_MAX) problems.push(`${id}: 문장이 깁니다(${len}자) – 나눠 쓰세요`);
      } else if (it.kind === 'opinion') {
        // Cards hold only what the paper says; the model's interpretation is not part of a digest.
        problems.push(`${id}: 해석·의견 항목은 쓰지 않습니다 – ${head(it.text)}`);
      } else {
        problems.push(`${id}: 알 수 없는 kind "${String(it.kind)}" 항목 제거 – ${head(it.text)}`);
      }
    }

    const bigNumbers = [];
    for (const b of Array.isArray(c.bigNumbers) ? c.bigNumbers : []) {
      if (!isObj(b)) continue;
      const ev = strList(b.evidence);
      if (!allKnown(ev)) {
        problems.push(`${id}: 근거 없는 bigNumber 제거 – ${head(b.value)}`);
        continue;
      }
      bigNumbers.push({ value: str(b.value), label: str(b.label), evidence: ev });
    }

    const figures = [];
    for (const f of Array.isArray(c.figures) ? c.figures : []) {
      if (!isObj(f)) continue;
      if (!Number.isInteger(f.page) || f.page < 1 || f.page > pageCount) {
        problems.push(`${id}: 페이지 범위를 벗어난 figure 제거 – ${head(f.label)}`);
        continue;
      }
      figures.push({ label: str(f.label), page: f.page, note: str(f.note) });
    }

    // Tables reproduce numbers from the paper, so like bigNumbers they need evidence.
    const tables = [];
    for (const t of Array.isArray(c.tables) ? c.tables : []) {
      if (!isObj(t)) continue;
      const columns = Array.isArray(t.columns) ? t.columns : [];
      const rows = Array.isArray(t.rows) ? t.rows : [];
      const shapeOk = columns.length > 0 && columns.every((x) => typeof x === 'string')
        && rows.every((r) => Array.isArray(r) && r.length === columns.length && r.every((x) => typeof x === 'string'));
      if (!shapeOk) {
        problems.push(`${id}: 형식이 맞지 않는 표 제거 – ${head(t.title)}`);
        continue;
      }
      const ev = strList(t.evidence);
      if (!allKnown(ev)) {
        problems.push(`${id}: 근거 없는 표 제거 – ${head(t.title)}`);
        continue;
      }
      tables.push({ title: str(t.title), columns: [...columns], rows: rows.map((r) => [...r]), evidence: ev, note: str(t.note) });
    }

    cards.push({
      id, section, question: str(c.question), answer: str(c.answer), explain: str(c.explain), bridge: str(c.bridge),
      items, bigNumbers, tables, figures,
    });
  });

  problems.push(...coverageProblems(cards, source));

  const glossary = (Array.isArray(digest.glossary) ? digest.glossary : [])
    .filter(isObj)
    .map((g) => ({ term: str(g.term), definition: str(g.definition) }));

  return { digest: { version: 1, paperId, takeaway, cards, glossary }, problems };
}

// Whole-paper checks, reported after the per-card problems.
function coverageProblems(cards, source) {
  const problems = [];
  for (const c of cards) {
    if (sentenceCount(c.explain) < EXPLAIN_MIN_SENTENCES) problems.push(`${c.id}: explain(해설)을 2~4문장으로 쓰세요`);
  }
  const min = minCards(source);
  if (cards.length < min) problems.push(`카드가 ${cards.length}장입니다 – 논문 전체를 담도록 ${min}장 이상 쓰세요`);
  const present = new Set(cards.map((c) => c.section));
  const missing = SECTIONS.filter((s) => !present.has(s));
  if (missing.length) problems.push(`빠진 섹션: ${missing.join(', ')}`);
  const results = cards.filter((c) => c.section === 'results');
  if (results.length && !results.some((c) => c.bigNumbers.length || c.tables.length)) {
    problems.push('결과 카드에 숫자(bigNumbers)나 표(tables)가 없습니다');
  }
  return problems;
}
