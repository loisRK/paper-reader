import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricBadges, citationTrend } from '../src/reader/public/views/search.js';
import { visibleItems, sentenceHtmlId, glossarySegments, cardEvidence, figureLayout, figureSlug, findFigure, figureDomIds, initialSourceTab } from '../src/reader/public/views/paper.js';
import { nextZoom, pagesToDraw, pdfErrorMessage } from '../src/reader/public/views/pdf-view.js';
import { progressPercent, tileState, folderPreview, hashingText } from '../src/reader/public/views/list.js';

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

test('visibleItems: 3min은 빈 배열, 10min은 claim만(예전 opinion은 숨김)', () => {
  const card = { items: [{ kind: 'claim', text: 'a', evidence: ['p1-s1'] }, { kind: 'opinion', text: 'b', evidence: [] }] };
  assert.deepEqual(visibleItems(card, '3min'), []);
  assert.deepEqual(visibleItems(card, '10min'), [card.items[0]]);
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

test('tileState: digest / extracted / pdf, linked adds Zotero tag', () => {
  assert.deepEqual(tileState({ state: 'digest', linked: false }), { tag: '요약 있음', tagClass: 'tag-ok', action: 'open', zotero: false });
  assert.deepEqual(tileState({ state: 'extracted', linked: true }), { tag: '요약 대기', tagClass: 'tag-wait', action: 'open', zotero: true });
  assert.deepEqual(tileState({ state: 'pdf', linked: false }), { tag: 'PDF만 있음', tagClass: 'tag-pdf', action: 'extract', zotero: false });
  // Unknown/missing state never offers extract.
  assert.equal(tileState({}).action, 'open');
  assert.equal(tileState({ state: 'weird' }).action, 'open');
});

test('folderPreview: first 50 unless expanded', () => {
  const many = Array.from({ length: 120 }, (_, i) => i);
  assert.deepEqual(folderPreview(many, false), { shown: many.slice(0, 50), hidden: 70 });
  assert.deepEqual(folderPreview(many, true), { shown: many, hidden: 0 });
  assert.deepEqual(folderPreview([1, 2], false), { shown: [1, 2], hidden: 0 });
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
import { selectionSentenceIds, sentenceMarks, statusText, NOTE_COLORS, emptyNotes, singleFlight, sharedFlight, conflictView, failedText, needsCommentSave, createPoller, popoverDownAction, pdfSelectionResult, pdfMarkLayers, pdfPointSentence, toolbarAction } from '../src/reader/public/views/notes.js';
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
  assert.equal(statusText('local', 3), '이 컴퓨터에만 저장됩니다');
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

test('needsCommentSave: only when the textarea differs from the saved comment', () => {
  assert.equal(needsCommentSave('a', 'a'), false);
  assert.equal(needsCommentSave('a', 'ab'), true);
  assert.equal(needsCommentSave(undefined, ''), false);
  assert.equal(needsCommentSave(null, ''), false);
  assert.equal(needsCommentSave('', 'x'), true);
  assert.equal(needsCommentSave('x', ''), true, 'clearing the memo is a change too');
  assert.equal(needsCommentSave('a', undefined), false);
});

function pollTimers() {
  const live = new Map();
  let id = 0;
  return {
    live,
    setTimeout: (fn) => { live.set(++id, fn); return id; },
    clearTimeout: (t) => { live.delete(t); },
    fire() { const [[t, fn]] = [...live]; live.delete(t); return fn(); },
  };
}

test('createPoller: kick while a run is in flight leaves exactly one timer chain', async () => {
  const timers = pollTimers();
  const pending = [];
  let runs = 0;
  const run = () => { runs += 1; return new Promise((r) => pending.push(r)); };
  const p = createPoller({ run, ms: 5000, ...timers });
  const a = p.kick();
  const b = p.kick(); // e.g. visibilitychange during the first poll
  pending.splice(0).forEach((r) => r());
  await Promise.all([a, b]);
  assert.equal(timers.live.size, 1, 'one chain');
  const c = timers.fire();
  pending.splice(0).forEach((r) => r());
  await c;
  assert.equal(timers.live.size, 1);
  assert.equal(runs, 3);
  p.stop();
  assert.equal(timers.live.size, 0);
  await p.kick();
  assert.equal(timers.live.size, 0, 'stopped poller never reschedules');
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

test('sharedFlight: concurrent calls share one run; a run that finishes without awaiting does not stick', async () => {
  let calls = 0;
  const sync = sharedFlight(async () => { calls += 1; return calls; });
  assert.equal(await sync(), 1);
  assert.equal(await sync(), 2); // must run again, not return the stale first result
  let release;
  const slow = sharedFlight(() => { calls += 1; return new Promise((r) => { release = r; }); });
  const a = slow(); const b = slow();
  assert.equal(a, b);
  release('done');
  assert.equal(await a, 'done');
  assert.equal(calls, 3);
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

test('popoverDownAction: outside text closes, same sentence toggles closed, other marked sentence reopens', () => {
  const base = { open: true, inPopover: false, openSid: 'p1-s1' };
  assert.equal(popoverDownAction({ ...base, inPopover: true, sid: null, marked: false }), 'keep');
  assert.equal(popoverDownAction({ ...base, open: false, sid: 'p1-s2', marked: true }), 'keep');
  assert.equal(popoverDownAction({ ...base, sid: 'p1-s9', marked: false }), 'close');
  assert.equal(popoverDownAction({ ...base, sid: null, marked: false }), 'close');
  assert.equal(popoverDownAction({ ...base, sid: 'p1-s1', marked: true }), 'close');
  assert.equal(popoverDownAction({ ...base, sid: 'p1-s2', marked: true }), 'reopen');
});

const figSrc = (figs) => ({
  blocks: [
    { id: 'b1', type: 'paragraph', page: 2, sentenceIds: ['s1'] },
    { id: 'b2', type: 'paragraph', page: 3, sentenceIds: ['s2'], inFigure: 'Figure 1' },
    { id: 'b3', type: 'caption', page: 3, sentenceIds: ['s3'] },
    { id: 'b4', type: 'paragraph', page: 3, sentenceIds: ['s4'], inFigure: 'Figure 1' },
  ],
  figures: figs,
});

test('figureLayout: 이미지 있는 그림 → 캡션 image-before, blockIds folded', () => {
  const f = { label: 'Figure 1', page: 3, captionSentenceId: 's3', image: 'fig-3-1.png', blockIds: ['b2', 'b4'] };
  const m = figureLayout(figSrc([f]));
  assert.deepEqual([...m.keys()].sort(), ['b2', 'b3', 'b4']);
  assert.equal(m.get('b3').role, 'image-before');
  assert.equal(m.get('b3').figure, f);
  assert.equal(m.get('b2').role, 'folded');
  assert.equal(m.get('b4').role, 'folded');
});

test('figureLayout: image null / figures 없음 / 옛 추출본 → 빈 Map', () => {
  assert.equal(figureLayout(figSrc([{ label: 'Figure 1', page: 3, captionSentenceId: 's3', image: null, blockIds: ['b2'] }])).size, 0);
  assert.equal(figureLayout({ blocks: [] }).size, 0);
  assert.equal(figureLayout(undefined).size, 0);
  assert.equal(figureLayout(figSrc([{ label: 'Figure 1', page: 3, captionSentenceId: 's3' }])).size, 0);
});

test('figureLayout: 캡션 블록을 못 찾으면 그 그림은 건너뜀', () => {
  const f = { label: 'Figure 1', page: 3, captionSentenceId: 'nope', image: 'a.png', blockIds: ['b2'] };
  assert.equal(figureLayout(figSrc([f])).size, 0);
});

test('figureSlug / findFigure', () => {
  assert.equal(figureSlug('Figure 1'), 'figure-1');
  assert.equal(figureSlug('Fig. 2(a)'), 'fig-2a');
  const a = { label: 'Figure 1', page: 3, image: 'x.png' };
  const b = { label: 'Figure 1', page: 7, image: 'y.png' };
  assert.equal(findFigure([a, b], { label: 'Figure 1', page: 7 }), b);
  assert.equal(findFigure([a, b], { label: 'Figure 1', page: 9 }), a);
  assert.equal(findFigure([a], { label: 'Figure 2', page: 3 }), null);
  assert.equal(findFigure(undefined, { label: 'Figure 1' }), null);
});

test('figureDomIds: 쪽 포함, 중복은 -2, 빈 slug는 figure', () => {
  const ids = figureDomIds([
    { label: 'Figure 1', page: 3 }, { label: 'Figure 1', page: 7 }, { label: 'Figure 1', page: 7 },
    { label: '그림', page: 2 },
  ]);
  assert.deepEqual(ids, ['fig-p3-figure-1', 'fig-p7-figure-1', 'fig-p7-figure-1-2', 'fig-p2-figure']);
});

test('figureLayout: 캡션 블록은 접지 않고, 블록당 역할은 하나', () => {
  const blocks = [
    { id: 'a', type: 'paragraph', page: 1, sentenceIds: ['sa'] },
    { id: 'c1', type: 'caption', page: 1, sentenceIds: ['sc1'] },
    { id: 'c2', type: 'caption', page: 1, sentenceIds: ['sc2'] },
    { id: 'd', type: 'paragraph', page: 1, sentenceIds: ['sd'] },
  ];
  const m = figureLayout({ blocks, figures: [
    { label: 'Figure 1', page: 1, captionSentenceId: 'sc1', image: 'a.png', blockIds: ['a', 'c1', 'c2'] },
    { label: 'Figure 2', page: 1, captionSentenceId: 'sc2', image: 'b.png', blockIds: ['a', 'd'] },
  ] });
  assert.equal(m.get('c1').role, 'image-before');
  assert.equal(m.get('c2').role, 'image-before');
  assert.equal(m.get('c2').figure.label, 'Figure 2');
  assert.equal(m.get('a').figure.label, 'Figure 1');
  assert.equal(m.get('d').figure.label, 'Figure 2');
  assert.equal(m.size, 4);
});

test('initialSourceTab: PDF 없음 → text, 기억한 text → text, 그 외 pdf', () => {
  assert.equal(initialSourceTab({ hasPdf: false, stored: 'pdf' }), 'text');
  assert.equal(initialSourceTab({ hasPdf: false, stored: null }), 'text');
  assert.equal(initialSourceTab({ hasPdf: true, stored: 'text' }), 'text');
  assert.equal(initialSourceTab({ hasPdf: true, stored: 'pdf' }), 'pdf');
  assert.equal(initialSourceTab({ hasPdf: true, stored: null }), 'pdf');
  assert.equal(initialSourceTab({ hasPdf: true, stored: 'garbage' }), 'pdf');
});

test('nextZoom: 0.1 단계로 맞추고 50%–300%로 묶는다', () => {
  assert.equal(nextZoom(1, 'in'), 1.1);
  assert.equal(nextZoom(1, 'out'), 0.9);
  assert.equal(nextZoom(0.86, 'in'), 0.9);
  assert.equal(nextZoom(0.86, 'out'), 0.8);
  assert.equal(nextZoom(0.5, 'out'), 0.5);
  assert.equal(nextZoom(3, 'in'), 3);
  assert.equal(nextZoom(2.95, 'in'), 3);
  assert.equal(nextZoom(0.2, 'in'), 0.5);
  assert.equal(nextZoom(0.7000000001, 'in'), 0.8);
  assert.equal(nextZoom(0.6999999999, 'out'), 0.6);
});

test('pagesToDraw: 보이는 쪽 ±1, 1..쪽 수 안', () => {
  assert.deepEqual([...pagesToDraw([1], 10)], [1, 2]);
  assert.deepEqual([...pagesToDraw([4, 5], 10)], [3, 4, 5, 6]);
  assert.deepEqual([...pagesToDraw([10], 10)], [9, 10]);
  assert.deepEqual([...pagesToDraw([], 10)], []);
});

test('pdfErrorMessage: 알려진 오류는 짧은 한국어, 영어 원문은 화면에 내보내지 않는다', () => {
  const e = (name, message, extra = {}) => Object.assign(new Error(message), { name }, extra);
  const hangul = /[\uac00-\ud7a3]/;
  const cases = [
    [e('InvalidPDFException', 'Invalid PDF structure.'), 'PDF 파일이 손상되었거나 올바른 PDF가 아닙니다.'],
    [e('FormatError', 'Bad FCHECK in flate stream'), 'PDF 파일이 손상되었거나 올바른 PDF가 아닙니다.'],
    [e('MissingPDFException', 'Missing PDF "x.pdf".'), 'PDF 파일을 찾을 수 없습니다.'],
    [e('ResponseException', 'Unexpected server response (404)', { status: 404, missing: true }), 'PDF 파일을 찾을 수 없습니다.'],
    [e('ResponseException', 'Unexpected server response (500)', { status: 500, missing: false }), 'PDF를 받아 오지 못했습니다.'],
    [e('PasswordException', 'No password given', { code: 1 }), '암호가 걸린 PDF는 열 수 없습니다.'],
    [e('PdfjsLoadError', 'PDF.js import failed', { cause: new TypeError('Failed to fetch dynamically imported module: http://x/pdf.min.mjs') }), 'PDF 보기 프로그램(PDF.js)을 불러오지 못했습니다. 새로고침해 보세요.'],
    [e('PdfNetworkError', 'PDF fetch failed', { cause: new TypeError('Failed to fetch') }), '서버에 연결하지 못했습니다. 리더 서버가 켜져 있는지 확인하세요.'],
    [new TypeError('Failed to fetch'), 'PDF를 여는 중 알 수 없는 오류가 났습니다.'],
    [new Error('Worker was destroyed'), 'PDF를 여는 중 알 수 없는 오류가 났습니다.'],
    ['not an error', 'PDF를 여는 중 알 수 없는 오류가 났습니다.'],
    [null, 'PDF를 여는 중 알 수 없는 오류가 났습니다.'],
  ];
  for (const [err, want] of cases) assert.equal(pdfErrorMessage(err), want, String(err?.name ?? err));
  // The server's own Korean 4xx reason passes through; English or 5xx text does not.
  const notFound = 'PDF 파일을 찾을 수 없습니다. 파일이 옮겨졌다면 다시 추출하세요.';
  assert.equal(pdfErrorMessage(e('PdfServerError', 'HTTP 404', { status: 404, serverMessage: notFound })), notFound);
  assert.equal(pdfErrorMessage(e('PdfServerError', 'HTTP 404', { status: 404, serverMessage: 'Not Found' })), 'PDF 파일을 찾을 수 없습니다.');
  assert.equal(pdfErrorMessage(e('PdfServerError', 'HTTP 500', { status: 500, serverMessage: '서버 오류: ENOENT: no such file' })), 'PDF를 받아 오지 못했습니다. 서버 오류입니다.');
  assert.equal(pdfErrorMessage(e('PdfServerError', 'HTTP 502', { status: 502, serverMessage: '' })), 'PDF를 받아 오지 못했습니다. 서버 오류입니다.');
  for (const [err] of cases) assert.ok(hangul.test(pdfErrorMessage(err)) && !/Failed|Invalid|Exception|password/i.test(pdfErrorMessage(err)));
});

// ----- PDF view: selection / marks / click (Task 5) -----
const pdfSource = {
  blocks: [{ id: 'b1', page: 1, sentenceIds: ['p1-s1', 'p1-s2', 'p1-s3'] }, { id: 'b2', page: 2, sentenceIds: ['p2-s1'] }],
  sentences: {
    'p1-s1': { page: 1, text: 'A', pdfRects: [[50, 688, 300, 700]] },
    'p1-s2': { page: 1, text: 'B', pdfRects: [[50, 668, 200, 680]] },
    'p1-s3': { page: 1, text: 'C', pdfRects: [[320, 688, 400, 700]] },
    'p2-s1': { page: 2, text: 'E', pdfRects: [[50, 688, 300, 700], [50, 676, 120, 686]] },
  },
};

test('pdfSelectionResult: 한 쪽 두 문장 → 두 ID(문장 순서), pages 1개', () => {
  const r = pdfSelectionResult({ pageRects: new Map([[1, [[50, 668, 200, 680], [60, 690, 280, 698]]]]), source: pdfSource });
  assert.deepEqual(r.ids, ['p1-s1', 'p1-s2']);
  assert.deepEqual([...r.pages], [1]);
});

test('pdfSelectionResult: 두 쪽에 걸치면 pages.size 2, ID는 쪽 순서', () => {
  const r = pdfSelectionResult({ pageRects: new Map([[2, [[50, 688, 300, 700]]], [1, [[320, 688, 400, 700]]]]), source: pdfSource });
  assert.deepEqual(r.ids, ['p1-s3', 'p2-s1']);
  assert.equal(r.pages.size, 2);
});

test('pdfSelectionResult: 문장과 겹치지 않으면(그림 속 글자 등) ids [] · pages 비어 있음', () => {
  const r = pdfSelectionResult({ pageRects: new Map([[1, [[50, 100, 200, 120]]]]), source: pdfSource });
  assert.deepEqual(r.ids, []);
  assert.equal(r.pages.size, 0);
  assert.deepEqual(pdfSelectionResult({ pageRects: new Map(), source: pdfSource }).ids, []);
  assert.deepEqual(pdfSelectionResult({ pageRects: new Map([[1, []]]), source: {} }).ids, []);
});

test('pdfSelectionResult: 한 쪽은 걸친 문장 없음 + 다른 쪽 한 문장 → 한 쪽으로 본다', () => {
  const r = pdfSelectionResult({ pageRects: new Map([[1, [[50, 100, 200, 120]]], [2, [[50, 688, 300, 700]]]]), source: pdfSource });
  assert.deepEqual(r.ids, ['p2-s1']);
  assert.deepEqual([...r.pages], [2]);
});

test('pdfMarkLayers: 내 하이라이트 = 문장 색, Zotero = 저장된 rects, rects 없으면 문장 pdfRects로 대신', () => {
  const notes = {
    highlights: [{ id: 'h1', sentenceIds: ['p1-s1', 'p1-s2'], color: '#f19837' }],
    zoteroAnnotations: [
      { key: 'Z1', page: 1, sentenceIds: ['p1-s3'], color: '#a28ae5', rects: [[320, 688, 380, 700]] },
      { key: 'Z2', page: 2, sentenceIds: ['p2-s1'], color: '#5fb236' }, // old data: no rects
      { key: 'Z3', page: 2, sentenceIds: [], color: '#aaaaaa', rects: [] }, // nothing to draw
    ],
  };
  const { marks, zoteroRects } = pdfMarkLayers(notes, pdfSource);
  assert.deepEqual([...marks], [['p1-s1', { color: '#f19837' }], ['p1-s2', { color: '#f19837' }]]);
  assert.deepEqual(zoteroRects, [
    { page: 1, rects: [[320, 688, 380, 700]], color: '#a28ae5' },
    { page: 2, rects: [[50, 688, 300, 700], [50, 676, 120, 686]], color: '#5fb236' },
  ]);
  const empty = pdfMarkLayers(null, pdfSource);
  assert.equal(empty.marks.size, 0);
  assert.deepEqual(empty.zoteroRects, []);
});

test('pdfPointSentence: 클릭 점(화면) → PDF 좌표 → 표시된 문장만', () => {
  // scale 1, page 612x792: viewport y = 792 - pdf y
  const viewport = { convertToPdfPoint: (x, y) => [x, 792 - y] };
  const pageBox = { left: 100, top: 50 };
  // p1-s2 rect [50,668,200,680] → css y 112..124 → client y 162..174
  const hit = { x: 100 + 60, y: 50 + 118, pageBox, viewport, page: 1, source: pdfSource };
  assert.equal(pdfPointSentence({ ...hit, sids: ['p1-s2'] }), 'p1-s2');
  assert.equal(pdfPointSentence({ ...hit, sids: ['p1-s1'] }), null);
  assert.equal(pdfPointSentence({ ...hit, sids: [] }), null);
  assert.equal(pdfPointSentence({ ...hit, x: 100 + 500, sids: ['p1-s2'] }), null);
});

test('toolbarAction: 끄는 중 selectionchange는 숨김, 놓으면·키보드 선택은 그린다', () => {
  assert.equal(toolbarAction({ dragging: true, trigger: 'selectionchange' }), 'hide');
  assert.equal(toolbarAction({ dragging: false, trigger: 'selectionchange' }), 'render');
  assert.equal(toolbarAction({ dragging: false, trigger: 'pointerup' }), 'render');
  assert.equal(toolbarAction({ dragging: false, trigger: 'mouseup' }), 'render');
});

test('hashingText: shown only while PDFs are being checked', () => {
  assert.equal(hashingText({ done: 2, total: 5 }), 'PDF 확인 중 (2/5)');
  assert.equal(hashingText({ done: 5, total: 5 }), null);
  assert.equal(hashingText(undefined), null);
});

// ---------- digest button (stage 3, Task 4) ----------
import { jobView, digestTracker } from '../src/reader/public/views/digest.js';
import { rowModel } from '../src/reader/public/views/list.js';

test('jobView: running states are busy info with Korean progress text', () => {
  assert.deepEqual(jobView({ state: 'extracting', attempt: 0, maxAttempts: 3 }), { text: 'PDF 추출 중…', busy: true, tone: 'info' });
  assert.deepEqual(jobView({ state: 'writing', attempt: 1, maxAttempts: 3 }), { text: '요약 쓰는 중… (1/3번째)', busy: true, tone: 'info' });
  assert.deepEqual(jobView({ state: 'checking', attempt: 2, maxAttempts: 3 }), { text: '검증 중…', busy: true, tone: 'info' });
  assert.deepEqual(jobView({ state: 'retrying', attempt: 2, maxAttempts: 3, problems: ['a', 'b', 'c'] }),
    { text: '검증 문제 3건 — 다시 쓰는 중 (2/3번째)', busy: true, tone: 'info' });
  // maxAttempts missing → 3; problems missing → 0건
  assert.equal(jobView({ state: 'writing', attempt: 1 }).text, '요약 쓰는 중… (1/3번째)');
  assert.equal(jobView({ state: 'retrying', attempt: 3 }).text, '검증 문제 0건 — 다시 쓰는 중 (3/3번째)');
});

test('jobView: terminal states', () => {
  assert.deepEqual(jobView({ state: 'done' }), { text: '요약을 만들었습니다', busy: false, tone: 'ok' });
  assert.deepEqual(jobView({ state: 'failed', message: 'AI 도구 로그인이 필요합니다.' }),
    { text: '요약을 만들지 못했습니다: AI 도구 로그인이 필요합니다.', busy: false, tone: 'error' });
  assert.deepEqual(jobView({ state: 'cancelled' }), { text: '취소했습니다', busy: false, tone: 'info' });
  // No message, or a message that already says it → no "…: " duplication.
  assert.equal(jobView({ state: 'failed' }).text, '요약을 만들지 못했습니다');
  assert.equal(jobView({ state: 'failed', message: '요약을 만들지 못했습니다. 서버 로그를 확인하세요.' }).text,
    '요약을 만들지 못했습니다. 서버 로그를 확인하세요.');
});

test('jobView: no job / unknown state', () => {
  assert.equal(jobView(null), null);
  assert.equal(jobView(undefined), null);
  assert.equal(jobView({ state: 'weird' }), null);
});

test('rowModel: digest / extracted / pdf rows', () => {
  const d = rowModel({ id: 'a b', title: 'T', journal: 'J', date: '2026', state: 'digest', linked: true, cardsRead: 2, cardsTotal: 8 });
  assert.deepEqual(d, {
    title: 'T', href: '#/paper/a%20b', meta: 'J · 2026', count: '2/8 카드', showBar: true,
    tags: [{ text: '요약 있음', class: 'tag-ok' }, { text: 'Zotero', class: 'tag-zotero', title: 'Zotero 항목과 연결됨' }],
    extract: false, digest: false,
  });
  const w = rowModel({ id: 'x', state: 'extracted', cardsTotal: 0 });
  assert.equal(w.title, 'x');
  assert.equal(w.meta, '저널 정보 없음');
  assert.equal(w.count, '카드 없음');
  assert.equal(w.digest, true);
  assert.equal(w.extract, false);
  assert.deepEqual(w.tags, [{ text: '요약 대기', class: 'tag-wait' }]);
  const p = rowModel({ id: 'f1', title: 'paper.pdf', state: 'pdf', file: 'sub/paper.pdf' });
  assert.equal(p.href, null);
  assert.equal(p.meta, 'sub/paper.pdf');
  assert.equal(p.count, null);
  assert.equal(p.showBar, false);
  assert.equal(p.extract, true);
  assert.equal(p.digest, true);
  assert.deepEqual(p.tags, [{ text: 'PDF만 있음', class: 'tag-pdf' }]);
});

test('rowModel: example papers get the 예제 tag (no Zotero tag) and no digest action', () => {
  const e = rowModel({ id: 'ex', title: 'E', state: 'extracted', linked: true, example: true });
  assert.equal(e.digest, false);
  assert.deepEqual(e.tags.map((t) => t.text), ['요약 대기', '예제']);
});

test('digestTracker: remembers started ids, forgets on untrack, survives storage errors', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const t = digestTracker(storage);
  t.track('a'); t.track('b'); t.track('a');
  assert.deepEqual(t.ids(), ['a', 'b']);
  assert.deepEqual(digestTracker(storage).ids(), ['a', 'b']);
  t.untrack('a');
  assert.deepEqual(digestTracker(storage).ids(), ['b']);
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  const b = digestTracker(broken);
  b.track('z');
  assert.deepEqual(b.ids(), ['z']);
  assert.deepEqual(digestTracker(null).ids(), []);
  assert.deepEqual(digestTracker({ getItem: () => '{bad', setItem() {} }).ids(), []);
});

import { modelLines } from '../src/reader/public/views/list.js';

test('modelLines: configured model and the last run (local M월 D일 HH:mm)', () => {
  const at = new Date(2026, 10, 19, 9, 5).toISOString();
  assert.deepEqual(modelLines({ configuredModel: 'opus', lastModel: { model: 'claude-opus-4-5', at } }), ['설정된 모델: opus', '최근 실행: claude-opus-4-5 · 11월 19일 09:05']);
  assert.deepEqual(modelLines({ configuredModel: '기본값 (계정 플랜에 따라 정해짐)', lastModel: null }), ['설정된 모델: 기본값 (계정 플랜에 따라 정해짐)']);
  assert.deepEqual(modelLines({}), ['설정된 모델: 기본값 (계정 플랜에 따라 정해짐)']);
  assert.deepEqual(modelLines({ configuredModel: 'x', lastModel: { model: 'm', at: 'garbage' } }), ['설정된 모델: x', '최근 실행: m']);
});

import { profileOptionText } from '../src/reader/public/views/list.js';

test('profileOptionText: alias · email', () => {
  assert.equal(profileOptionText({ label: 'claude-yvin', email: 'y@x.com' }), 'claude-yvin · y@x.com');
  assert.equal(profileOptionText({ label: 'claude', email: '로그인 정보 없음' }), 'claude · 로그인 정보 없음');
});
