export const SECTIONS = ['motivation', 'gap', 'idea', 'method', 'setup', 'results', 'analysis', 'limits', 'implications'];

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
        items.push({ kind: 'claim', text: str(it.text), evidence: ev });
      } else if (it.kind === 'opinion') {
        items.push({ kind: 'opinion', text: str(it.text), evidence: ev.filter(known) });
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

    cards.push({ id, section, question: str(c.question), answer: str(c.answer), bridge: str(c.bridge), items, bigNumbers, figures });
  });

  const glossary = (Array.isArray(digest.glossary) ? digest.glossary : [])
    .filter(isObj)
    .map((g) => ({ term: str(g.term), definition: str(g.definition) }));

  return { digest: { version: 1, paperId, takeaway, cards, glossary }, problems };
}
