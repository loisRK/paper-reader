import { test } from 'node:test';
import assert from 'node:assert/strict';
import { obsidianReady, noteOptions, exportMessage } from '../src/reader/public/views/obsidian.js';
import { connectionsView, CONN_EMPTY_TEXT, jobUpdateMode } from '../src/reader/public/views/connections.js';
import { jobView } from '../src/reader/public/views/digest.js';

const SET = { vault: '/v', folder: 'Notes/Papers', researchNote: 'Notes/연구.md', vaultOk: true };

test('obsidianReady: export needs a reachable vault; connections also need a research note', () => {
  assert.deepEqual(obsidianReady(SET), { export: true, connections: true, exportHint: null, connectionsHint: null });
  const none = obsidianReady({ vault: '', folder: 'Notes/Papers', researchNote: null, vaultOk: false });
  assert.equal(none.export, false);
  assert.equal(none.connections, false);
  assert.match(none.exportHint, /목록 화면.*Obsidian.*vault/);
  assert.match(none.connectionsHint, /목록 화면.*Obsidian/);
  const gone = obsidianReady({ ...SET, vaultOk: false });
  assert.equal(gone.export, false);
  assert.match(gone.exportHint, /vault를 찾을 수 없습니다/);
  const noNote = obsidianReady({ ...SET, researchNote: null });
  assert.equal(noNote.export, true);
  assert.equal(noNote.connections, false);
  assert.match(noNote.connectionsHint, /연구 주제 노트/);
  // not loaded yet / failed to load
  assert.equal(obsidianReady(null).export, false);
  assert.equal(obsidianReady(undefined).connections, false);
});

test('noteOptions: name without .md first, folder after; value is the vault path', () => {
  assert.deepEqual(noteOptions(['Notes/연구 주제 - A.md', 'Top.md', 'x/y/Deep.MD']), [
    { value: 'Notes/연구 주제 - A.md', text: '연구 주제 - A · Notes', title: 'Notes/연구 주제 - A' },
    { value: 'Top.md', text: 'Top', title: 'Top' },
    { value: 'x/y/Deep.MD', text: 'Deep · x/y', title: 'x/y/Deep' },
  ]);
  assert.deepEqual(noteOptions(null), []);
});

test('exportMessage', () => {
  assert.equal(exportMessage({ relPath: 'Notes/Papers/@k 읽기 노트.md' }), 'Obsidian에 저장했습니다: Notes/Papers/@k 읽기 노트.md');
});

test('jobView: connections jobs get their own texts (never "요약")', () => {
  const c = (j) => jobView({ kind: 'connections', maxAttempts: 2, ...j });
  assert.deepEqual(c({ state: 'writing', attempt: 1 }), { text: '연결 메모 쓰는 중… (1/2번째)', busy: true, tone: 'info' });
  assert.deepEqual(c({ state: 'checking', attempt: 1 }), { text: '검증 중…', busy: true, tone: 'info' });
  assert.equal(c({ state: 'retrying', attempt: 2, problems: ['a'] }).text, '검증 문제 1건 — 다시 쓰는 중 (2/2번째)');
  assert.deepEqual(c({ state: 'done' }), { text: '연구 연결 메모를 만들었습니다', busy: false, tone: 'ok' });
  assert.equal(c({ state: 'failed', message: '연결 메모를 만들지 못했습니다. 기존 연결 메모는 그대로입니다.' }).text,
    '연결 메모를 만들지 못했습니다. 기존 연결 메모는 그대로입니다.');
  assert.equal(c({ state: 'failed', message: 'Invalid API key' }).text, '연결 메모를 만들지 못했습니다: Invalid API key');
  assert.equal(c({ state: 'failed' }).text, '연결 메모를 만들지 못했습니다');
  assert.equal(c({ state: 'cancelled' }).text, '취소했습니다');
  // digest jobs unchanged
  assert.equal(jobView({ state: 'writing', attempt: 1, maxAttempts: 3 }).text, '요약 쓰는 중… (1/3번째)');
  assert.equal(jobView({ kind: 'digest', state: 'failed', message: 'x' }).text, '요약을 만들지 못했습니다: x');
});

const ITEMS = [
  { id: 'k1', target: '축 A', text: '설명 1', evidence: ['p1-s1'] },
  { id: 'k2', target: '축 B', text: '설명 2', evidence: ['p1-s2', 'p2-s1'], edited: true },
];
const CONN = { version: 1, paperId: 'p', researchNote: 'Notes/연구.md', items: ITEMS };

test('connectionsView: hidden for example papers and papers without a digest', () => {
  assert.equal(connectionsView({ settings: SET, connections: null, job: null, example: true, hasDigest: true }).show, false);
  assert.equal(connectionsView({ settings: SET, connections: null, job: null, example: false, hasDigest: false }).show, false);
});

test('connectionsView: not configured → hint, make button disabled, closed', () => {
  const v = connectionsView({ settings: { ...SET, researchNote: null }, connections: null, job: null, hasDigest: true });
  assert.equal(v.show, true);
  assert.equal(v.configured, false);
  assert.match(v.hint, /Obsidian/);
  assert.deepEqual(v.button, { text: '연결 메모 만들기', disabled: true });
  assert.equal(v.open, false);
  assert.deepEqual(v.items, []);
  assert.equal(v.emptyText, null);
});

test('connectionsView: configured, none yet → 연결 메모 만들기 enabled, intro text, closed', () => {
  const v = connectionsView({ settings: SET, connections: null, job: null, hasDigest: true });
  assert.equal(v.configured, true);
  assert.equal(v.hint, null);
  assert.deepEqual(v.button, { text: '연결 메모 만들기', disabled: false });
  assert.equal(v.open, false);
  assert.ok(v.intro);
});

test('connectionsView: items → open, 다시 만들기, editable, edited flag kept', () => {
  const v = connectionsView({ settings: SET, connections: CONN, job: null, hasDigest: true });
  assert.equal(v.open, true);
  assert.deepEqual(v.button, { text: '다시 만들기', disabled: false });
  assert.equal(v.editable, true);
  assert.equal(v.items.length, 2);
  assert.equal(v.items[1].edited, true);
  assert.equal(v.items[0].edited, false);
  assert.equal(v.emptyText, null);
  assert.equal(v.noteName, '연구');
  assert.equal(v.otherNote, false);
});

test('connectionsView: empty items → the "found nothing" line, closed, 다시 만들기', () => {
  const v = connectionsView({ settings: SET, connections: { ...CONN, items: [] }, job: null, hasDigest: true });
  assert.equal(v.emptyText, CONN_EMPTY_TEXT);
  assert.equal(CONN_EMPTY_TEXT, '연구 주제 노트와 이어지는 내용을 찾지 못했습니다.');
  assert.equal(v.open, false);
  assert.equal(v.button.text, '다시 만들기');
});

test('connectionsView: a running job disables the button and editing, shows progress', () => {
  const job = { kind: 'connections', state: 'writing', attempt: 1, maxAttempts: 2, log: [] };
  const v = connectionsView({ settings: SET, connections: CONN, job, hasDigest: true });
  assert.equal(v.busy, true);
  assert.equal(v.button.disabled, true);
  assert.equal(v.editable, false);
  assert.equal(v.status.text, '연결 메모 쓰는 중… (1/2번째)');
  assert.equal(v.open, true);
  // finished job: editable again, status kept
  const done = connectionsView({ settings: SET, connections: CONN, job: { ...job, state: 'done' }, hasDigest: true });
  assert.equal(done.busy, false);
  assert.equal(done.editable, true);
  assert.equal(done.status.tone, 'ok');
});

test('connectionsView: memo made from another research note is flagged', () => {
  const v = connectionsView({ settings: { ...SET, researchNote: 'Notes/다른.md' }, connections: CONN, job: null, hasDigest: true });
  assert.equal(v.otherNote, true);
  assert.equal(v.noteName, '연구');
});

test('connectionsView: malformed items are skipped', () => {
  const v = connectionsView({ settings: SET, connections: { items: [null, { id: 'k1', text: 't' }, 5] }, job: null, hasDigest: true });
  assert.deepEqual(v.items, [{ id: 'k1', target: '', text: 't', evidence: [], edited: false }]);
});

test('obsidianReady: a failed settings read says so (not "vault missing")', () => {
  const r = obsidianReady({ loadError: true });
  assert.equal(r.export, false);
  assert.equal(r.connections, false);
  assert.equal(r.exportHint, 'Obsidian 설정을 읽지 못했습니다.');
  assert.equal(r.connectionsHint, 'Obsidian 설정을 읽지 못했습니다.');
});

test('jobUpdateMode: polls of the same running job patch in place; transitions re-render', () => {
  const run = (state, id = 'j1') => ({ id, kind: 'connections', state, attempt: 1, maxAttempts: 2, log: [] });
  assert.equal(jobUpdateMode(run('writing'), run('writing')), 'patch');
  assert.equal(jobUpdateMode(run('writing'), run('checking')), 'patch');
  assert.equal(jobUpdateMode(run('checking'), run('retrying')), 'patch');
  assert.equal(jobUpdateMode(null, run('writing')), 'full');
  assert.equal(jobUpdateMode(run('writing'), run('done')), 'full');
  assert.equal(jobUpdateMode(run('done'), run('done')), 'full');
  assert.equal(jobUpdateMode(run('writing', 'j1'), run('writing', 'j2')), 'full');
  assert.equal(jobUpdateMode(run('writing'), null), 'full');
});
