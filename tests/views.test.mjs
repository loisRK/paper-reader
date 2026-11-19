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

test('cardEvidence: 10min은 표 근거도 포함, 3min은 비어 있음', () => {
  const card = { items: [{ kind: 'claim', text: 'a', evidence: ['p1-s1'] }], tables: [{ evidence: ['p8-s6', 'p1-s1'] }] };
  assert.deepEqual(cardEvidence(card, '10min'), ['p1-s1', 'p8-s6']);
  assert.deepEqual(cardEvidence(card, '3min'), []);
});

// ---------- notes (Task 6) ----------
import { selectionSentenceIds, sentenceMarks, statusText, NOTE_COLORS, emptyNotes, singleFlight, conflictView, failedText } from '../src/reader/public/views/notes.js';
import { ZOTERO_COLORS } from '../src/zotero/annotations.mjs';

test('selectionSentenceIds: forward and backward selection give same ordered ids', () => {
  const order = ['a-s1', 'a-s2', 'a-s3', 'a-s4'];
  assert.deepEqual(selectionSentenceIds(order, 'a-s2', 'a-s4'), ['a-s2', 'a-s3', 'a-s4']);
  assert.deepEqual(selectionSentenceIds(order, 'a-s4', 'a-s2'), ['a-s2', 'a-s3', 'a-s4']);
  assert.deepEqual(selectionSentenceIds(order, 'a-s3', 'a-s3'), ['a-s3']);
  assert.deepEqual(selectionSentenceIds(order, 'a-s1', 'nope'), []);
});

test('sentenceMarks: mine and zotero marks on same sentence both kept', () => {
  const marks = sentenceMarks({
    highlights: [{ id: 'h1', sentenceIds: ['s1', 's2'], color: '#ffd400', comment: 'hi' }],
    zoteroAnnotations: [{ key: 'K1', sentenceIds: ['s2'], text: 't', comment: 'z', color: '#ff6666' }],
  });
  assert.deepEqual(marks.get('s1'), [{ kind: 'mine', color: '#ffd400', comment: 'hi', hid: 'h1' }]);
  assert.deepEqual(marks.get('s2').map((m) => m.kind), ['mine', 'zotero']);
  assert.equal(marks.get('s2')[1].key, 'K1');
  assert.equal(sentenceMarks({}).size, 0);
});

test('statusText: per status', () => {
  assert.equal(statusText('connected', 0), 'Zotero 연결됨');
  assert.equal(statusText('offline', 2), 'Zotero 연결 대기 중 (보낼 메모 2개)');
  assert.equal(statusText('needs-auth', 0), 'Zotero 쓰기 허용이 필요합니다');
  assert.equal(statusText('denied', 0), 'Zotero 쓰기 허용이 필요합니다');
  assert.equal(statusText('rate-limited', 0), 'Zotero 허용 요청이 많아 잠시 후 다시 시도합니다');
  assert.equal(statusText('readonly', 0), 'Zotero 10 이상에서만 메모를 Zotero로 보낼 수 있습니다. 메모는 이 컴퓨터에 저장됩니다.');
  assert.equal(statusText('example', 0), '예제 논문에는 메모를 저장하지 않습니다.');
});

test('conflictView: Zotero-deleted highlight offers 다시 보내기 / 삭제; others a dismiss', () => {
  assert.deepEqual(conflictView({ mine: { comment: '내 말', color: '#ffd400' }, zoteroDeleted: true, at: 't' }), {
    text: 'Zotero에서 삭제된 하이라이트입니다. 내가 쓴 내용: 내 말', actions: ['resend', 'delete'],
  });
  assert.deepEqual(conflictView({ mine: { comment: 'x', color: '#ffd400' }, at: 't' }), {
    text: 'Zotero에서 바뀌었습니다. 내가 쓴 내용: x', actions: ['dismiss'],
  });
  assert.deepEqual(conflictView({ mine: { deleted: true }, at: 't' }), {
    text: 'Zotero에서 바뀌어 삭제하지 않았습니다.', actions: ['dismiss'],
  });
  assert.equal(conflictView(null), null);
});

test('failedText: count of memos Zotero refused, empty when none', () => {
  assert.equal(failedText(2), '보내지 못한 메모 2개');
  assert.equal(failedText(0), '');
  assert.equal(failedText(undefined), '');
});

test('NOTE_COLORS matches ZOTERO_COLORS (source of truth)', () => {
  assert.deepEqual(Object.fromEntries(NOTE_COLORS.map((c) => [c.name, c.value])), ZOTERO_COLORS);
});

test('emptyNotes: usable before first poll', () => {
  const n = emptyNotes();
  assert.deepEqual([n.highlights, n.zoteroAnnotations], [[], []]);
  assert.equal(sentenceMarks(n).size, 0);
  assert.notEqual(emptyNotes().highlights, n.highlights);
});

test('singleFlight: ignores calls while running, allows again afterwards', async () => {
  let calls = 0;
  let release;
  const f = singleFlight(() => { calls += 1; return new Promise((r) => { release = r; }); });
  const first = f();
  assert.equal(await f(), undefined);
  assert.equal(calls, 1);
  release(); await first;
  const second = f(); release(); await second;
  assert.equal(calls, 2);
});

import { debounce, memosVisible } from '../src/reader/public/views/card-memos.js';

function fakeTimers() {
  let now = 0; let nextId = 1; const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.fn(); }
    },
  };
}

test('debounce calls once with last args after quiet period', () => {
  const t = fakeTimers(); const calls = [];
  const d = debounce((x) => calls.push(x), 800, t);
  d('a'); t.advance(500); d('b'); t.advance(500); d('c');
  assert.deepEqual(calls, []);
  t.advance(800);
  assert.deepEqual(calls, ['c']);
  t.advance(2000);
  assert.deepEqual(calls, ['c']);
});

test('debounce flush runs pending call immediately, cancel drops it', () => {
  const t = fakeTimers(); const calls = [];
  const d = debounce((x) => calls.push(x), 800, t);
  d('a'); d.flush();
  assert.deepEqual(calls, ['a']);
  t.advance(1000);
  assert.deepEqual(calls, ['a']);
  d.flush(); // nothing pending
  assert.deepEqual(calls, ['a']);
  d('b'); d.cancel(); t.advance(1000); d.flush();
  assert.deepEqual(calls, ['a']);
});

test('memosVisible hides memos in 3min mode and for example papers', () => {
  assert.equal(memosVisible('10min', false), true);
  assert.equal(memosVisible('3min', false), false);
  assert.equal(memosVisible('10min', true), false);
});

import { shouldApplyRemote, needsResend } from '../src/reader/public/views/card-memos.js';
const idle = { dirty: false, failed: false, saving: 0, focused: false };

test('failed save: remote ignored and resend needed', () => {
  const st = { ...idle, failed: true };
  assert.equal(shouldApplyRemote(st), false);
  assert.equal(needsResend(st), true);
});
test('in-flight, dirty or focused: remote ignored', () => {
  assert.equal(shouldApplyRemote({ ...idle, saving: 1 }), false);
  assert.equal(shouldApplyRemote({ ...idle, dirty: true }), false);
  assert.equal(shouldApplyRemote({ ...idle, focused: true }), false);
});
test('acknowledged: remote applied, no resend', () => {
  assert.equal(shouldApplyRemote(idle), true);
  assert.equal(needsResend(idle), false);
});

import { isRetryable, shouldPollRetry, shouldToast } from '../src/reader/public/views/card-memos.js';
test('permanent failure: no poll retry, remote still ignored', () => {
  assert.equal(isRetryable(404), false);
  assert.equal(isRetryable(403), false);
  const st = { dirty: false, failed: true, permanent: true, saving: 0, focused: false };
  assert.equal(shouldPollRetry(st), false);
  assert.equal(shouldApplyRemote(st), false);
  assert.equal(needsResend(st), true); // blur / user edit may still retry
});
test('retryable failure: poll retries', () => {
  for (const s of [undefined, 0, 500, 503, 408, 429]) assert.equal(isRetryable(s), true);
  assert.equal(shouldPollRetry({ failed: true, permanent: false, saving: 0 }), true);
  assert.equal(shouldPollRetry({ failed: true, permanent: false, saving: 1 }), false);
});
test('toast only on first failure', () => {
  assert.equal(shouldToast({ wasFailed: false }), true);
  assert.equal(shouldToast({ wasFailed: true }), false);
});
