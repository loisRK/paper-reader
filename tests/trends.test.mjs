import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTrends } from '../src/search/trends.mjs';
import { DEFAULTS } from '../src/config.mjs';

const cfg = structuredClone(DEFAULTS);
const now = new Date('2026-11-18T00:00:00Z');
let k = 0;
const mk = (o = {}) => ({
  openalexId: `W${++k}`, doi: `10.1/${k}`, title: `T${k}`, abstract: '', authors: [], journal: 'J0', issn: [],
  publicationDate: '2026-01-10', citedBy: 5, countsByYear: [], topic: { id: 'T0', name: 'Topic0' }, oaPdfUrl: null, ...o,
});

test('surge ranks by recentCitations and excludes papers younger than 3 months', () => {
  const a = mk({ countsByYear: [{ year: 2026, count: 10 }, { year: 2025, count: 12 }] }); // 10+1=11
  const b = mk({ countsByYear: [{ year: 2026, count: 3 }] });
  const young = mk({ publicationDate: '2026-09-01', countsByYear: [{ year: 2026, count: 99 }] });
  const { sections } = selectTrends([b, young, a], cfg, now);
  assert.deepEqual(sections.citationSurge.papers, [a.openalexId, b.openalexId]);
});

test('emerging marks topic with zero prior papers as isNew', () => {
  const recent = (t) => mk({ publicationDate: '2026-10-01', topic: { id: t, name: t } });
  const works = [recent('N'), recent('N'), recent('O'), recent('O'), mk({ publicationDate: '2025-06-01', topic: { id: 'O', name: 'O' } })];
  const { sections } = selectTrends(works, cfg, now);
  const n = sections.emergingTopics.topics.find((t) => t.name === 'N');
  const o = sections.emergingTopics.topics.find((t) => t.name === 'O');
  assert.equal(n.isNew, true);
  assert.equal(o.isNew, false);
  assert.ok(n.growth > o.growth);
  assert.equal(sections.emergingTopics.topics[0].name, 'N');
});

test('journalFlow picks one most-cited paper per top journal', () => {
  const low = mk({ journal: 'A', publicationDate: '2026-08-01', citedBy: 1 });
  const high = mk({ journal: 'A', publicationDate: '2026-09-01', citedBy: 9 });
  const other = mk({ journal: 'B', publicationDate: '2026-09-01' });
  const old = mk({ journal: 'C', publicationDate: '2025-01-01' });
  const { sections } = selectTrends([low, high, other, old], cfg, now);
  const j = sections.journalFlow.journals;
  assert.equal(j[0].name, 'A');
  assert.equal(j[0].count, 2);
  assert.deepEqual(j[0].papers, [high.openalexId]);
  assert.equal(j.some((x) => x.name === 'C'), false);
});

test('fewer than 3 qualifying papers produces Korean note with count', () => {
  const twoWorks = [mk(), mk()];
  const { sections } = selectTrends(twoWorks, cfg, now);
  assert.match(sections.citationSurge.note, /2편뿐/);
  assert.match(selectTrends([], cfg, now).sections.citationSurge.note, /0편입니다/);
});

test('paper in two sections gets both badges', () => {
  const w = mk({ publicationDate: '2026-08-01', journal: 'A' });
  const { badgesById } = selectTrends([w], cfg, now);
  assert.deepEqual(badgesById.get(w.openalexId), ['surge', 'journal']);
});
