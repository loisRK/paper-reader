// A digest that passes every coverage check: all nine sections, enough cards,
// two-sentence explain on every card, and a results card with a big number.
const ORDER = ['motivation', 'gap', 'idea', 'method', 'setup', 'results', 'analysis', 'limits', 'implications'];

export function fullDigest({ paperId = 'p1', evidence = 'p1-s1', cards = 12 } = {}) {
  const sections = [...ORDER];
  while (sections.length < cards) sections.splice(4, 0, 'method');
  return {
    version: 1,
    paperId,
    takeaway: { text: 't', evidence: [evidence], why: 'w' },
    cards: sections.slice(0, Math.max(cards, 0)).map((section, i) => ({
      id: `c${i + 1}`,
      section,
      question: 'q',
      answer: 'a',
      explain: '첫째 문장이다. 둘째 문장이다.',
      bridge: '',
      items: [{ kind: 'claim', label: '', text: 'ok', evidence: [evidence] }],
      ...(section === 'results' ? { bigNumbers: [{ value: '1%', label: 'x', evidence: [evidence] }] } : {}),
    })),
    glossary: [],
  };
}
