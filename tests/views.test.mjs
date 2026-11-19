import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricBadges, citationTrend } from '../src/reader/public/views/search.js';
import { visibleItems, sentenceHtmlId, glossarySegments, cardEvidence } from '../src/reader/public/views/paper.js';
import { progressPercent } from '../src/reader/public/views/list.js';

test('metricBadges: null → 미확인, true → 확인 배지', () => {
  const all = metricBadges({ scopus: null, sjrQuartile: null, sjrYear: null, wos: null, scie: null, ssci: null });
  assert.deepEqual(all, [
    { label: 'Scopus 미확인', unverified: true },
    { label: 'Q 미확인', unverified: true },
    { label: 'WoS 미확인', unverified: true },
    { label: 'SCIE 미확인', unverified: true },
  ]);
  const ok = metricBadges({ scopus: true, sjrQuartile: 'Q1', sjrYear: 2024, wos: true, scie: true, ssci: null });
  assert.deepEqual(ok, [
    { label: 'Scopus', unverified: false },
    { label: 'SJR Q1 (2024)', unverified: false },
    { label: 'WoS', unverified: false },
    { label: 'SCIE', unverified: false },
  ]);
});

test('metricBadges: SSCI만 확인되면 SCIE 미확인 대신 SSCI, 누락 metrics도 안전', () => {
  const b = metricBadges({ scopus: true, sjrQuartile: 'Q2', sjrYear: null, wos: true, scie: null, ssci: true });
  assert.deepEqual(b.map((x) => x.label), ['Scopus', 'SJR Q2', 'WoS', 'SSCI']);
  assert.equal(metricBadges(undefined).every((x) => x.unverified), true);
  assert.equal(metricBadges(undefined).length, 4);
});

test('visibleItems: 3min은 빈 배열, 10min은 전체', () => {
  const card = { items: [{ kind: 'claim', text: 'a', evidence: ['p1-s1'] }, { kind: 'opinion', text: 'b', evidence: [] }] };
  assert.deepEqual(visibleItems(card, '3min'), []);
  assert.deepEqual(visibleItems(card, '10min'), card.items);
  assert.deepEqual(visibleItems({}, '10min'), []);
});

test('sentenceHtmlId', () => {
  assert.equal(sentenceHtmlId('p5-s12'), 's-p5-s12');
});

test('glossarySegments: 첫 등장만 용어로 감싸고 이후는 일반 텍스트', () => {
  const glossary = [{ term: 'AIOps', definition: 'AI for IT operations' }, { term: 'agent', definition: '에이전트' }];
  const seen = new Set();
  const a = glossarySegments('AIOps agent and AIOps', glossary, seen);
  assert.deepEqual(a, [
    { text: 'AIOps', term: 'AIOps', definition: 'AI for IT operations' },
    { text: ' ' },
    { text: 'agent', term: 'agent', definition: '에이전트' },
    { text: ' and AIOps' },
  ]);
  assert.deepEqual(glossarySegments('another agent <b>', glossary, seen), [{ text: 'another agent <b>' }]);
  assert.deepEqual(glossarySegments('', glossary, new Set()), []);
});

test('cardEvidence: 모드에 보이는 항목의 evidence만 모은다', () => {
  const card = {
    items: [{ kind: 'claim', text: 'a', evidence: ['p1-s1', 'p1-s2'] }],
    bigNumbers: [{ value: '1', label: '', evidence: ['p2-s1'] }],
  };
  assert.deepEqual(cardEvidence(card, '10min'), ['p1-s1', 'p1-s2', 'p2-s1']);
  assert.deepEqual(cardEvidence(card, '3min'), []);
});

test('progressPercent', () => {
  assert.equal(progressPercent({ cardsRead: 1, cardsTotal: 4 }), 25);
  assert.equal(progressPercent({ cardsRead: 0, cardsTotal: 0 }), 0);
});

test('citationTrend: last 3 years ending at the latest year, missing years as 0', () => {
  assert.equal(citationTrend([{ year: 2026, count: 20 }, { year: 2024, count: 3 }, { year: 2025, count: 12 }, { year: 2022, count: 9 }]),
    '인용 2024:3 · 2025:12 · 2026:20');
  assert.equal(citationTrend([{ year: 2026, count: 5 }, { year: 2024, count: 1 }]), '인용 2024:1 · 2025:0 · 2026:5');
  assert.equal(citationTrend([]), null);
  assert.equal(citationTrend(undefined), null);
  assert.equal(citationTrend([{ year: 'x', count: 1 }]), null);
});
