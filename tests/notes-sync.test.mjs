import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readNotes, writeNotes, readPending, writePending,
  addHighlight, updateHighlight, removeHighlight, setCardMemo, resolveNoteConflict,
} from '../src/notes/store.mjs';
import { syncPaper, noteHtml } from '../src/notes/sync.mjs';
import { ZoteroWriteError } from '../src/zotero/write.mjs';

const ID = 'paper1';
const ITEM = 'ITEMKEY1';
const ATT = 'ATTKEY01';
const SID = 'server-A';

const source = {
  zotero: { itemKey: ITEM, attachmentKey: ATT },
  sentences: {
    'p1-s1': { text: 'First sentence.', page: 1, rects: [[50, 100, 300, 112]], pdfRects: [[50, 688, 300, 700]] },
    'p1-s2': { text: 'Second one.', page: 1, rects: [[50, 120, 200, 132]], pdfRects: [[50, 668, 200, 680]] },
    'p2-s1': { text: 'Other page.', page: 2, rects: [[50, 100, 300, 112]], pdfRects: [[50, 688, 300, 700]] },
    'p2-old': { text: 'old', page: 2, rects: [[0, 0, 1, 1]] },
  },
};
const cards = [
  { id: 'c1', question: 'Why <this>?' },
  { id: 'c2', question: 'What next?' },
  { id: 'c3', question: 'How & when?' },
];
const ONLINE = { running: true, serverId: SID, version: '10.0.9', writable: true };

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pr-notes-'));
}

// In-memory Zotero library behind the writer interface.
function fakeWriter(prefix = 'NEW') {
  let lib = 10;
  let n = 0;
  const items = new Map();
  const calls = [];
  const w = {
    items,
    calls,
    fail: {}, // method -> ZoteroWriteError to throw
    noVersionOnCreate: false,
    rejectCreate: null, // (data) => message: reported in createItems' failed{} (Zotero rejected it)
    pageSize: Infinity,
    bump: () => ++lib,
    put(key, data, version = ++lib) {
      items.set(key, { key, version, data: { ...data } });
      return items.get(key);
    },
    readonly: false, // like the real writer on Zotero 7–9: reads OK, writes throw 'readonly'
    check(method) {
      calls.push(method);
      if (w.fail[method]) throw w.fail[method];
      if (w.readonly && ['createItems', 'patchItem', 'deleteItem'].includes(method)) {
        throw new ZoteroWriteError('readonly', 'Zotero 10 이상이 필요합니다.');
      }
    },
    async serverId() { return SID; },
    async authorize() { throw new Error('authorize must never be called by sync'); },
    async createItems(list) {
      w.check('createItems');
      const out = { success: {}, successful: {}, failed: {} };
      list.forEach((data, i) => {
        const why = w.rejectCreate?.(data);
        if (why) { out.failed[i] = { key: null, code: 400, message: why }; return; }
        const key = `${prefix}${String(++n).padStart(5, '0')}`;
        const it = w.put(key, data);
        out.success[i] = key;
        out.successful[i] = w.noVersionOnCreate ? { key, data: it.data } : structuredClone(it);
      });
      return out;
    },
    async patchItem(key, version, data) {
      w.check('patchItem');
      const it = items.get(key);
      if (!it) throw new ZoteroWriteError('http', 'not found', { status: 404 });
      if (it.version !== version) throw new ZoteroWriteError('http', 'conflict', { status: 412 });
      it.data = { ...it.data, ...data };
      it.version = ++lib;
      return it.version;
    },
    async deleteItem(key, version) {
      w.check('deleteItem');
      const it = items.get(key);
      if (!it) throw new ZoteroWriteError('http', 'not found', { status: 404 });
      if (it.version !== version) throw new ZoteroWriteError('http', 'conflict', { status: 412 });
      items.delete(key);
      lib++;
    },
    async getItem(key) {
      w.check('getItem');
      const it = items.get(key);
      return it ? structuredClone(it) : null;
    },
    async listChildren(parentKey, since, { itemType } = {}) {
      w.check('listChildren');
      calls.push(`listChildren:${parentKey}:${itemType}:${since}`);
      if (since !== undefined && since !== null && since === lib) return { items: [], libraryVersion: lib, notModified: true };
      const list = [...items.values()]
        .filter((it) => it.data.parentItem === parentKey && (!itemType || it.data.itemType === itemType))
        .slice(0, w.pageSize)
        .map((it) => structuredClone(it));
      return { items: list, libraryVersion: lib, notModified: false };
    },
  };
  return w;
}

const writes = (w) => w.calls.filter((c) => ['createItems', 'patchItem', 'deleteItem'].includes(c));

test('addHighlight saves locally and queues one op even when Zotero is offline', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'memo' });
  assert.match(h.id, /^h-[0-9a-z]{8}$/);
  const w = fakeWriter();
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: { running: false, serverId: null, version: null, writable: false } });
  assert.equal(r.status, 'offline');
  assert.equal(r.pending, 1);
  const notes = await readNotes(dir, ID);
  assert.equal(notes.highlights.length, 1);
  assert.equal(notes.highlights[0].comment, 'memo');
  assert.equal(notes.highlights[0].zoteroKey, null);
  assert.deepEqual((await readPending(dir, ID)).ops.map((o) => [o.op, o.id]), [['upsert-highlight', h.id]]);
  assert.equal(w.calls.length, 0);
});

test('Zotero not usable (getServerInfo running:false with message) → offline, message passed through', async () => {
  const dir = await tmp();
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w = fakeWriter();
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: { running: false, serverId: null, version: null, writable: false, message: 'Zotero 로컬 API가 응답하지 않습니다(HTTP 403).' } });
  assert.equal(r.status, 'offline');
  assert.equal(r.message, 'Zotero 로컬 API가 응답하지 않습니다(HTTP 403).');
  assert.equal(w.calls.length, 0);
});

test('readNotes/readPending return defaults; write is atomic and round-trips', async () => {
  const dir = await tmp();
  const notes = await readNotes(dir, ID);
  assert.equal(notes.version, 1);
  assert.deepEqual(notes.highlights, []);
  assert.deepEqual(notes.cardMemos, {});
  assert.deepEqual(notes.note, { zoteroKey: null, zoteroVersion: null });
  assert.deepEqual(await readPending(dir, ID), { ops: [] });
  notes.cardMemos.c1 = 'x';
  await writeNotes(dir, ID, notes);
  await writePending(dir, ID, { ops: [{ op: 'upsert-note', at: 't' }] });
  assert.equal((await readNotes(dir, ID)).cardMemos.c1, 'x');
  assert.equal((await readPending(dir, ID)).ops.length, 1);
  assert.deepEqual((await fs.readdir(path.join(dir, ID))).sort(), ['notes.json', 'pending.json']);
  await assert.rejects(() => readNotes(dir, '../evil'));
});

test('flush creates annotation, stores zoteroKey/version, clears pending', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1', 'p1-s2'], color: '#ff6666', comment: 'c' });
  const w = fakeWriter();
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.deepEqual(r, { status: 'connected', pending: 0, message: null, failed: 0, failedMessage: null });
  const notes = await readNotes(dir, ID);
  const local = notes.highlights.find((x) => x.id === h.id);
  assert.ok(local.zoteroKey);
  const remote = w.items.get(local.zoteroKey);
  assert.equal(local.zoteroVersion, remote.version);
  assert.equal(remote.data.parentItem, ATT);
  assert.equal(remote.data.annotationComment, 'c');
  assert.equal(remote.data.annotationColor, '#ff6666');
  assert.deepEqual(remote.data.tags, [{ tag: 'paper-reader' }]);
  assert.equal(notes.serverId, SID);
  assert.deepEqual(notes.zoteroAnnotations, []);
  // pull after our write must not use the stale cached version
  assert.ok(w.calls.includes(`listChildren:${ATT}:annotation:undefined`));
  assert.deepEqual((await readPending(dir, ID)).ops, []);

  // update -> patch, version follows
  await updateHighlight(dir, ID, h.id, { comment: 'c2' });
  const r2 = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r2.pending, 0);
  assert.equal(w.items.get(local.zoteroKey).data.annotationComment, 'c2');
  assert.equal((await readNotes(dir, ID)).highlights[0].zoteroVersion, w.items.get(local.zoteroKey).version);
  assert.equal(w.calls.filter((c) => c === 'createItems').length, 1);
});

test('created item without version in response -> version fetched via getItem', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  const w = fakeWriter();
  w.noVersionOnCreate = true;
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const local = (await readNotes(dir, ID)).highlights[0];
  assert.equal(local.zoteroVersion, w.items.get(local.zoteroKey).version);
});

test('second sync with nothing changed uses cached library versions (304)', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  w.calls.length = 0;
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.status, 'connected');
  assert.equal(writes(w).length, 0);
  assert.ok(w.calls.some((c) => c.startsWith(`listChildren:${ATT}:annotation:`) && !c.endsWith('undefined')));
});

for (const [code, status] of [['denied', 'denied'], ['needs-auth', 'needs-auth'], ['rate-limited', 'rate-limited'], ['offline', 'offline']]) {
  test(`${code} during flush keeps op in pending and returns status ${status}`, async () => {
    const dir = await tmp();
    await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'keep me' });
    await setCardMemo(dir, ID, 'c1', 'card memo');
    const w = fakeWriter();
    w.fail.createItems = new ZoteroWriteError(code, `err ${code}`);
    const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
    assert.equal(r.status, status);
    assert.equal(r.pending, 2);
    assert.equal((await readPending(dir, ID)).ops.length, 2);
    const notes = await readNotes(dir, ID);
    assert.equal(notes.highlights[0].comment, 'keep me');
    assert.equal(notes.highlights[0].zoteroKey, null);
    assert.equal(notes.cardMemos.c1, 'card memo');
    assert.equal(w.calls.filter((c) => c === 'createItems').length, 1, 'stops at first failure');
    if (code === 'needs-auth') assert.ok(w.calls.includes('listChildren'), 'pull still runs');
  });
}

test('permanent failure (createItems failed[]) marks the op and skips it; later ops still flush', async () => {
  const dir = await tmp();
  const bad = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'rejected' });
  const good = await addHighlight(dir, ID, { sentenceIds: ['p1-s2'], color: '#ffd400', comment: 'ok' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w = fakeWriter();
  w.rejectCreate = (data) => (data.annotationComment === 'rejected' ? 'Parent item not found' : null);
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.status, 'connected');
  assert.equal(r.failed, 1);
  assert.match(r.failedMessage, /Parent item not found/);
  assert.equal(r.pending, 1);
  const ops = (await readPending(dir, ID)).ops;
  assert.deepEqual(ops.map((o) => [o.op, o.id]), [['upsert-highlight', bad.id]]);
  assert.match(ops[0].error, /Zotero 항목 생성 실패/);
  assert.ok(ops[0].failedAt);
  const notes = await readNotes(dir, ID);
  assert.ok(notes.highlights.find((h) => h.id === good.id).zoteroKey, 'later op flushed');
  assert.ok(notes.note.zoteroKey, 'note flushed');
  assert.equal(notes.highlights.find((h) => h.id === bad.id).comment, 'rejected', 'memo kept locally');

  // not retried on its own
  const creates = () => w.calls.filter((c) => c === 'createItems').length;
  const before = creates();
  const r2 = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(creates(), before);
  assert.equal(r2.failed, 1);

  // editing that highlight clears the error and retries
  w.rejectCreate = null;
  await updateHighlight(dir, ID, bad.id, { comment: 'rejected, fixed' });
  assert.equal((await readPending(dir, ID)).ops[0].error, undefined);
  const r3 = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r3.failed, 0);
  assert.equal(r3.pending, 0);
  assert.ok((await readNotes(dir, ID)).highlights.find((h) => h.id === bad.id).zoteroKey);
});

for (const [status, permanent] of [[400, true], [404, true], [403, true], [408, false], [429, false], [500, false], [503, false]]) {
  test(`http ${status} during flush is ${permanent ? 'permanent (skipped, marked)' : 'transient (stops flush, unmarked)'}`, async () => {
    const dir = await tmp();
    await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
    await setCardMemo(dir, ID, 'c1', 'memo');
    const w = fakeWriter();
    let first = true;
    const orig = w.createItems;
    w.createItems = async (list) => {
      if (first) { first = false; w.calls.push('createItems'); throw new ZoteroWriteError('http', `Zotero 쓰기 실패: HTTP ${status}`, { status }); }
      return orig(list);
    };
    const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
    const ops = (await readPending(dir, ID)).ops;
    if (permanent) {
      assert.equal(r.failed, 1);
      assert.equal(r.pending, 1);
      assert.equal(ops[0].op, 'upsert-highlight');
      assert.match(ops[0].error, new RegExp(`HTTP ${status}`));
      assert.ok((await readNotes(dir, ID)).note.zoteroKey, 'note op after it flushed');
    } else {
      assert.equal(r.failed, 0);
      assert.equal(r.pending, 2, 'stops at first transient failure');
      assert.ok(ops.every((o) => o.error === undefined));
      assert.match(r.message, /Zotero 동기화 실패/);
    }
  });
}

test('two updates to same highlight collapse into one pending op', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
  await updateHighlight(dir, ID, h.id, { comment: 'b' });
  await updateHighlight(dir, ID, h.id, { color: '#5fb236' });
  await setCardMemo(dir, ID, 'c1', 'x');
  await setCardMemo(dir, ID, 'c2', 'y');
  const ops = (await readPending(dir, ID)).ops;
  assert.deepEqual(ops.map((o) => [o.op, o.id]), [['upsert-highlight', h.id], ['upsert-note', undefined]]);
  const local = (await readNotes(dir, ID)).highlights[0];
  assert.equal(local.comment, 'b');
  assert.equal(local.color, '#5fb236');
});

test('removing a never-sent highlight drops the pending op; a sent one is deleted in Zotero', async () => {
  const dir = await tmp();
  const a = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  assert.equal(await removeHighlight(dir, ID, a.id), true);
  assert.deepEqual((await readPending(dir, ID)).ops, []);
  assert.deepEqual((await readNotes(dir, ID)).highlights, []);

  const b = await addHighlight(dir, ID, { sentenceIds: ['p1-s2'], color: '#ffd400', comment: '' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  await removeHighlight(dir, ID, b.id);
  assert.deepEqual((await readPending(dir, ID)).ops.map((o) => o.op), ['delete-highlight']);
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0);
  assert.equal(w.items.has(key), false);

  // delete of an already-gone item counts as success
  const c = await addHighlight(dir, ID, { sentenceIds: ['p1-s2'], color: '#ffd400', comment: '' });
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key2 = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  await removeHighlight(dir, ID, c.id);
  w.items.delete(key2);
  const r2 = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r2.pending, 0);
});

test('version conflict: Zotero value wins, my value kept in conflict.mine', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  // user edits in Zotero
  const it = w.items.get(key);
  it.data.annotationComment = 'from zotero';
  it.data.annotationColor = '#2ea8e5';
  it.version = w.bump();
  // and I edit locally before the next sync
  await updateHighlight(dir, ID, h.id, { comment: 'mine' });
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0);
  const local = (await readNotes(dir, ID)).highlights[0];
  assert.equal(local.comment, 'from zotero');
  assert.equal(local.color, '#2ea8e5');
  assert.equal(local.zoteroVersion, it.version);
  assert.deepEqual(local.conflict.mine, { comment: 'mine', color: '#ffd400' });
  assert.ok(local.conflict.at);
  assert.equal(w.items.get(key).data.annotationComment, 'from zotero', 'not overwritten');
});

test('412 from patch is handled as a conflict too', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  await updateHighlight(dir, ID, h.id, { comment: 'mine' });
  w.fail.patchItem = new ZoteroWriteError('http', 'conflict', { status: 412 });
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0);
  const local = (await readNotes(dir, ID)).highlights[0];
  assert.equal(local.comment, 'orig');
  assert.deepEqual(local.conflict.mine, { comment: 'mine', color: '#ffd400' });
});

test('Zotero edit of my highlight is pulled into local record', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  const it = w.items.get(key);
  it.data.annotationComment = 'edited in zotero';
  it.version = w.bump();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const local = (await readNotes(dir, ID)).highlights[0];
  assert.equal(local.comment, 'edited in zotero');
  assert.equal(local.zoteroVersion, it.version);
  assert.equal(local.conflict, null);
});

test('my highlight deleted in Zotero → removed locally, not recreated', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  w.items.delete(key);
  w.bump();
  w.calls.length = 0;
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.deepEqual((await readNotes(dir, ID)).highlights, []);
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(writes(w).length, 0);
  assert.equal(w.items.size, 0);
});

test('deleted in Zotero while a local edit is pending (upsert path) → kept with zoteroDeleted conflict, not recreated', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  w.items.delete(key);
  w.bump();
  await updateHighlight(dir, ID, h.id, { comment: 'my new words', color: '#5fb236' });
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0, 'op dropped');
  let local = (await readNotes(dir, ID)).highlights;
  assert.equal(local.length, 1);
  assert.equal(local[0].zoteroKey, null);
  assert.equal(local[0].zoteroVersion, null);
  assert.equal(local[0].comment, 'my new words');
  assert.deepEqual(local[0].conflict.mine, { comment: 'my new words', color: '#5fb236' });
  assert.equal(local[0].conflict.zoteroDeleted, true);
  assert.ok(local[0].conflict.at);
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.calls.filter((c) => c === 'createItems').length, 1, 'never auto-recreated');
  assert.equal((await readNotes(dir, ID)).highlights.length, 1);

  // 다시 보내기 = updateHighlight with the same values → conflict cleared, recreated
  await updateHighlight(dir, ID, h.id, { comment: 'my new words', color: '#5fb236' });
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  local = (await readNotes(dir, ID)).highlights[0];
  assert.equal(local.conflict, null);
  assert.ok(local.zoteroKey && local.zoteroKey !== key);
  assert.equal(w.items.get(local.zoteroKey).data.annotationComment, 'my new words');
});

test('untagged in Zotero while a local edit is pending → kept with zoteroDeleted conflict, Zotero item untouched', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  w.items.get(key).data.tags = [];
  w.items.get(key).version = w.bump();
  await updateHighlight(dir, ID, h.id, { comment: 'pending words' });
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const local = (await readNotes(dir, ID)).highlights[0];
  assert.equal(local.comment, 'pending words');
  assert.equal(local.zoteroKey, null);
  assert.equal(local.conflict.zoteroDeleted, true);
  assert.equal(w.items.get(key).data.annotationComment, 'orig');
  assert.equal(w.calls.filter((c) => c === 'patchItem').length, 0);
});

test('deleted in Zotero with a queued edit seen only by the pull (readonly) → kept with zoteroDeleted conflict', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  w.items.delete(key);
  w.bump();
  await updateHighlight(dir, ID, h.id, { comment: 'unsent' });
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: { ...ONLINE, writable: false } });
  const local = (await readNotes(dir, ID)).highlights;
  assert.equal(local.length, 1);
  assert.equal(local[0].comment, 'unsent');
  assert.equal(local[0].zoteroKey, null);
  assert.deepEqual(local[0].conflict.mine, { comment: 'unsent', color: '#ffd400' });
  assert.equal(local[0].conflict.zoteroDeleted, true);
  assert.deepEqual((await readPending(dir, ID)).ops, [], 'op dropped, not auto-recreated');
});

test('deleted in Zotero, local differs from last sent but no op (pull path) → kept with zoteroDeleted conflict', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const notes = await readNotes(dir, ID);
  notes.highlights[0].comment = 'edited but op lost';
  await writeNotes(dir, ID, notes);
  w.items.delete(notes.highlights[0].zoteroKey);
  w.bump();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const local = (await readNotes(dir, ID)).highlights;
  assert.equal(local.length, 1);
  assert.equal(local[0].conflict.zoteroDeleted, true);
  assert.equal(local[0].conflict.mine.comment, 'edited but op lost');
});

test('my highlight missing from a truncated child list is kept (confirmed via getItem)', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'keep' });
  const w = fakeWriter();
  w.put('USER0001', { itemType: 'annotation', parentItem: ATT, annotationType: 'highlight', annotationPosition: '{}', tags: [] });
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  w.pageSize = 1; // only the user annotation comes back
  w.bump();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal((await readNotes(dir, ID)).highlights.length, 1);
});

test('user-made Zotero annotation appears in zoteroAnnotations with matched sentenceIds and is never patched/deleted', async () => {
  const dir = await tmp();
  const w = fakeWriter();
  w.put('USER0001', {
    itemType: 'annotation', parentItem: ATT, annotationType: 'highlight',
    annotationText: 'Second one.', annotationComment: 'user note', annotationColor: '#5fb236',
    annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[50, 668, 200, 680]] }), tags: [],
  });
  w.put('USER0002', {
    itemType: 'annotation', parentItem: ATT, annotationType: 'ink',
    annotationComment: '', annotationColor: '#ff6666',
    annotationPosition: JSON.stringify({ pageIndex: 1, paths: [[50, 688, 300, 700]], width: 2 }), tags: [],
  });
  w.put('USER0003', {
    itemType: 'annotation', parentItem: ATT, annotationType: 'note',
    annotationComment: 'sticky', annotationColor: '#ffd400',
    annotationPosition: JSON.stringify({ pageIndex: 1, rects: [[50, 688, 300, 700]] }), tags: [],
  });
  w.put('USERATT9', { itemType: 'annotation', parentItem: 'OTHERATT', annotationType: 'highlight', tags: [] });
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const notes = await readNotes(dir, ID);
  const za = Object.fromEntries(notes.zoteroAnnotations.map((a) => [a.key, a]));
  assert.deepEqual(Object.keys(za).sort(), ['USER0001', 'USER0002', 'USER0003']);
  assert.deepEqual(za.USER0001, {
    key: 'USER0001', page: 1, sentenceIds: ['p1-s2'], text: 'Second one.', comment: 'user note', color: '#5fb236',
    rects: [[50, 668, 200, 680]],
  });
  assert.deepEqual(za.USER0003.rects, [[50, 688, 300, 700]]);
  assert.deepEqual(za.USER0002.rects, [], 'ink has paths, not rects');
  assert.equal(za.USER0002.page, 2);
  assert.deepEqual(za.USER0002.sentenceIds, []);
  assert.deepEqual(za.USER0003.sentenceIds, [], 'note annotations are never matched to sentences');
  assert.equal(za.USER0003.comment, 'sticky');
  // my own highlight is not listed as a Zotero annotation
  assert.equal(notes.zoteroAnnotations.some((a) => a.key === notes.highlights[0].zoteroKey), false);

  await removeHighlight(dir, ID, h.id);
  await updateHighlight(dir, ID, 'h-unknown0', { comment: 'x' });
  w.calls.length = 0;
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.items.has('USER0001'), true);
  assert.equal(w.items.get('USER0001').data.annotationComment, 'user note');
  assert.equal(w.calls.filter((c) => c === 'patchItem').length, 0);
  assert.equal(w.calls.filter((c) => c === 'deleteItem').length, 1, 'only my own highlight is deleted');
});

test('never deletes an item that lost the paper-reader tag', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  w.items.get(key).data.tags = [];
  await removeHighlight(dir, ID, h.id);
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0);
  assert.equal(w.items.has(key), true);
  assert.equal(w.calls.filter((c) => c === 'deleteItem').length, 0);
});

test('server id changed → keys cleared, everything re-queued, nothing written with old keys', async () => {
  const dir = await tmp();
  const a = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
  const b = await addHighlight(dir, ID, { sentenceIds: ['p1-s2'], color: '#ffd400', comment: 'b' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w1 = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w1, serverInfo: ONLINE });
  const old = await readNotes(dir, ID);
  const oldKeys = [...old.highlights.map((h) => h.zoteroKey), old.note.zoteroKey];
  assert.ok(oldKeys.every(Boolean));
  await updateHighlight(dir, ID, a.id, { comment: 'a2' });
  await removeHighlight(dir, ID, b.id);

  const w2 = fakeWriter('BBB');
  const info = { ...ONLINE, serverId: 'server-B' };
  w2.serverId = async () => 'server-B';
  w2.fail.createItems = new ZoteroWriteError('offline', 'down');
  const r = await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: info });
  assert.equal(r.status, 'offline');
  const mid = await readNotes(dir, ID);
  assert.equal(mid.serverId, 'server-B');
  assert.ok(mid.highlights.every((h) => h.zoteroKey === null && h.zoteroVersion === null));
  assert.deepEqual(mid.note, { zoteroKey: null, zoteroVersion: null });
  assert.deepEqual(
    (await readPending(dir, ID)).ops.map((o) => [o.op, o.id]),
    [['upsert-highlight', a.id], ['upsert-note', undefined]],
  );
  assert.equal(w2.calls.filter((c) => ['patchItem', 'deleteItem'].includes(c)).length, 0);

  delete w2.fail.createItems;
  const r2 = await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: info });
  assert.equal(r2.pending, 0);
  assert.equal(w2.calls.filter((c) => ['patchItem', 'deleteItem'].includes(c)).length, 0);
  assert.equal(w2.items.size, 2);
  const now = await readNotes(dir, ID);
  assert.ok(now.highlights.every((h) => !oldKeys.includes(h.zoteroKey)));
  assert.equal(now.highlights[0].comment, 'a2');
});

// Same library synced to another computer: same item keys, different server id and versions.
function syncedCopy(from, prefix = 'BBB') {
  const w = fakeWriter(prefix);
  for (let i = 0; i < 50; i++) w.bump();
  for (const [k, it] of from.items) w.put(k, structuredClone(it.data));
  w.serverId = async () => 'server-B';
  return w;
}
const SERVER_B = { ...ONLINE, serverId: 'server-B' };

test('server id changed, same keys on new server → adopt keys and versions, no create, no duplicate', async () => {
  const dir = await tmp();
  const a = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
  const b = await addHighlight(dir, ID, { sentenceIds: ['p1-s2'], color: '#ffd400', comment: 'b' });
  const c = await addHighlight(dir, ID, { sentenceIds: ['p2-s1'], color: '#ffd400', comment: 'c' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w1 = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w1, serverInfo: ONLINE });
  const old = await readNotes(dir, ID);
  const keyOf = (hid) => old.highlights.find((h) => h.id === hid).zoteroKey;

  const w2 = syncedCopy(w1);
  // edited on the other computer (no local pending edit) → adopted silently
  w2.items.get(keyOf(b.id)).data.annotationComment = 'b from other computer';
  // local edits made before this sync
  await updateHighlight(dir, ID, a.id, { comment: 'a2' });
  await removeHighlight(dir, ID, c.id);
  await setCardMemo(dir, ID, 'c2', 'second');

  const r = await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: SERVER_B });
  assert.equal(r.status, 'connected');
  assert.equal(r.pending, 0);
  assert.equal(w2.calls.filter((x) => x === 'createItems').length, 0, 'nothing recreated');
  assert.equal(w2.items.size, 3, 'a, b and the note; c deleted');
  const now = await readNotes(dir, ID);
  assert.equal(now.serverId, 'server-B');
  const ha = now.highlights.find((h) => h.id === a.id);
  const hb = now.highlights.find((h) => h.id === b.id);
  assert.equal(ha.zoteroKey, keyOf(a.id));
  assert.equal(w2.items.get(ha.zoteroKey).data.annotationComment, 'a2', 'pending edit patched with the new version');
  assert.equal(ha.zoteroVersion, w2.items.get(ha.zoteroKey).version);
  assert.equal(hb.zoteroKey, keyOf(b.id));
  assert.equal(hb.comment, 'b from other computer');
  assert.equal(hb.conflict, null);
  assert.equal(w2.items.has(keyOf(c.id)), false, 'local delete applied to the same item');
  assert.equal(now.note.zoteroKey, old.note.zoteroKey);
  assert.equal(w2.items.get(now.note.zoteroKey).data.note, noteHtml(cards, { c1: 'memo', c2: 'second' }));
  assert.equal(w1.calls.filter((x) => ['patchItem', 'deleteItem'].includes(x)).length, 0);
});

test('server id changed: pending local edit vs different Zotero value → Zotero wins, mine kept in conflict', async () => {
  const dir = await tmp();
  const a = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w1 = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w1, serverInfo: ONLINE });
  const old = await readNotes(dir, ID);
  const w2 = syncedCopy(w1);
  w2.items.get(old.highlights[0].zoteroKey).data.annotationComment = 'zotero side';
  w2.items.get(old.note.zoteroKey).data.note = '<p>edited elsewhere</p>';
  await updateHighlight(dir, ID, a.id, { comment: 'mine' });
  await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: SERVER_B });
  const now = await readNotes(dir, ID);
  assert.equal(now.highlights[0].comment, 'zotero side');
  assert.deepEqual(now.highlights[0].conflict.mine, { comment: 'mine', color: '#ffd400' });
  assert.ok(now.note.conflict?.at, 'note content differs → conflict, not overwritten');
  assert.equal(w2.items.get(old.note.zoteroKey).data.note, '<p>edited elsewhere</p>');
  assert.equal(writes(w2).length, 0);
});

test('server id changed: missing keys on new server → keys cleared and recreated; present ones kept', async () => {
  const dir = await tmp();
  const a = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
  const b = await addHighlight(dir, ID, { sentenceIds: ['p1-s2'], color: '#ffd400', comment: 'b' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w1 = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w1, serverInfo: ONLINE });
  const old = await readNotes(dir, ID);
  const keyA = old.highlights.find((h) => h.id === a.id).zoteroKey;
  const keyB = old.highlights.find((h) => h.id === b.id).zoteroKey;
  const w2 = syncedCopy(w1);
  w2.items.delete(keyB);
  w2.items.delete(old.note.zoteroKey);
  const r = await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: SERVER_B });
  assert.equal(r.pending, 0);
  const now = await readNotes(dir, ID);
  assert.equal(now.highlights.find((h) => h.id === a.id).zoteroKey, keyA);
  const nb = now.highlights.find((h) => h.id === b.id);
  assert.ok(nb.zoteroKey && nb.zoteroKey !== keyB, 'recreated');
  assert.equal(w2.items.get(nb.zoteroKey).data.annotationComment, 'b');
  assert.ok(now.note.zoteroKey && now.note.zoteroKey !== old.note.zoteroKey);
  assert.equal(w2.calls.filter((x) => x === 'createItems').length, 2);
  assert.equal(w2.calls.filter((x) => ['patchItem', 'deleteItem'].includes(x)).length, 0);
});

test('server id changed: lookup fails → nothing adopted or written, retried next sync', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
  const w1 = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w1, serverInfo: ONLINE });
  const w2 = syncedCopy(w1);
  w2.fail.getItem = new ZoteroWriteError('offline', 'down');
  const r = await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: SERVER_B });
  assert.equal(r.status, 'offline');
  assert.equal((await readNotes(dir, ID)).serverId, SID, 'still the old server: retried next time');
  assert.equal(writes(w2).length, 0);
  delete w2.fail.getItem;
  await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: SERVER_B });
  assert.equal((await readNotes(dir, ID)).serverId, 'server-B');
  assert.equal(writes(w2).length, 0);
});

test('server id changed: permanently failed ops are retried', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'a' });
  const w1 = fakeWriter();
  w1.rejectCreate = () => 'nope';
  await syncPaper(dir, ID, { source, cards, writer: w1, serverInfo: ONLINE });
  assert.ok((await readPending(dir, ID)).ops[0].error);
  const w2 = syncedCopy(w1);
  const r = await syncPaper(dir, ID, { source, cards, writer: w2, serverInfo: SERVER_B });
  assert.equal(r.failed, 0);
  assert.equal(r.pending, 0);
  assert.ok((await readNotes(dir, ID)).highlights[0].zoteroKey);
});

test('readonly (Zotero 9) → no writes attempted, pull still works, memos kept', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'm' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w = fakeWriter();
  w.readonly = true;
  w.put('USER0001', {
    itemType: 'annotation', parentItem: ATT, annotationType: 'highlight', annotationText: 't',
    annotationComment: '', annotationColor: '#ffd400',
    annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[50, 688, 300, 700]] }), tags: [],
  });
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: { ...ONLINE, version: '9.0.1', writable: false } });
  assert.equal(r.status, 'readonly');
  assert.equal(r.pending, 2);
  assert.equal(writes(w).length, 0);
  const notes = await readNotes(dir, ID);
  assert.equal(notes.zoteroAnnotations.length, 1);
  assert.deepEqual(notes.zoteroAnnotations[0].sentenceIds, ['p1-s1']);
  assert.equal(notes.highlights[0].comment, 'm');
  assert.equal(notes.cardMemos.c1, 'memo');
});

test('NEEDS_REEXTRACT keeps op and returns re-extract message', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p2-old'], color: '#ffd400', comment: 'm' });
  const w = fakeWriter();
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.status, 'connected');
  assert.equal(r.pending, 1);
  assert.equal(r.message, `원문을 다시 추출해야 Zotero에 보낼 수 있습니다: npm run extract -- ${ID}`);
  assert.equal(writes(w).length, 0);
  assert.equal((await readNotes(dir, ID)).highlights[0].comment, 'm');
});

test('card memos create a child note, then patch it; Zotero-side edit marks conflict and is not overwritten', async () => {
  const dir = await tmp();
  await setCardMemo(dir, ID, 'c2', 'line1\nline2');
  const w = fakeWriter();
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0);
  const notes = await readNotes(dir, ID);
  const it = w.items.get(notes.note.zoteroKey);
  assert.equal(it.data.itemType, 'note');
  assert.equal(it.data.parentItem, ITEM);
  assert.deepEqual(it.data.tags, [{ tag: 'paper-reader' }]);
  assert.equal(it.data.note, '<h1>Paper Reader 메모</h1><h2>2. What next?</h2><p>line1<br>line2</p>');
  assert.equal(notes.note.zoteroVersion, it.version);
  assert.ok(w.calls.includes(`listChildren:${ITEM}:note:undefined`));

  await setCardMemo(dir, ID, 'c1', 'first');
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.match(w.items.get(notes.note.zoteroKey).data.note, /<h2>1\. Why &lt;this&gt;\?<\/h2><p>first<\/p>/);

  // user edits note in Zotero → conflict flag on pull, local memos untouched
  const n = w.items.get(notes.note.zoteroKey);
  n.data.note = '<p>user rewrote</p>';
  n.version = w.bump();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const after = await readNotes(dir, ID);
  assert.ok(after.note.conflict?.at);
  assert.equal(after.note.zoteroVersion, n.version, 'records Zotero version so a later overwrite will not 412');
  assert.equal(after.cardMemos.c1, 'first');
  // later local memo edit must not overwrite the Zotero note
  await setCardMemo(dir, ID, 'c3', 'more');
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  const r3 = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r3.status, 'connected');
  assert.equal(r3.message, null);
  assert.deepEqual((await readPending(dir, ID)).ops.map((o) => o.op), ['upsert-note'], 'note op stays queued, skipped');
  assert.equal(r3.pending, 1);
  assert.equal(w.items.get(notes.note.zoteroKey).data.note, '<p>user rewrote</p>');
  const later = await readNotes(dir, ID);
  assert.equal(later.cardMemos.c3, 'more');
  assert.ok(later.highlights.find((x) => x.id === h.id).zoteroKey, 'ops after the skipped note op still flush');
});

async function noteConflictSetup() {
  const dir = await tmp();
  await setCardMemo(dir, ID, 'c1', 'mine');
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).note.zoteroKey;
  const n = w.items.get(key);
  n.data.note = '<p>zotero edit</p>';
  n.version = w.bump();
  await setCardMemo(dir, ID, 'c2', 'second');
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.ok((await readNotes(dir, ID)).note.conflict);
  return { dir, w, key };
}

test('resolveNoteConflict overwrite → my memos are written over the Zotero note', async () => {
  const { dir, w, key } = await noteConflictSetup();
  await resolveNoteConflict(dir, ID, 'overwrite');
  let notes = await readNotes(dir, ID);
  assert.equal(notes.note.conflict, null);
  assert.deepEqual((await readPending(dir, ID)).ops.map((o) => o.op), ['upsert-note']);
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0);
  assert.equal(w.items.get(key).data.note, noteHtml(cards, { c1: 'mine', c2: 'second' }));
  notes = await readNotes(dir, ID);
  assert.equal(notes.note.zoteroVersion, w.items.get(key).version);
  assert.equal(notes.note.conflict, null);
});

test('resolveNoteConflict keep-zotero → Zotero note stays; a later memo edit raises the conflict again, only overwrite writes', async () => {
  const { dir, w, key } = await noteConflictSetup();
  await resolveNoteConflict(dir, ID, 'keep-zotero');
  let notes = await readNotes(dir, ID);
  assert.equal(notes.note.conflict, null);
  assert.equal(notes.note.zoteroEdited, true);
  assert.deepEqual(notes.cardMemos, { c1: 'mine', c2: 'second' });
  assert.deepEqual((await readPending(dir, ID)).ops, []);
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.items.get(key).data.note, '<p>zotero edit</p>');
  assert.equal((await readNotes(dir, ID)).note.conflict, null, 'no new conflict without a new edit');

  // next card-memo edit: saved locally, NOT written over the Zotero-edited note, banner back
  await setCardMemo(dir, ID, 'c3', 'third');
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.items.get(key).data.note, '<p>zotero edit</p>');
  assert.equal(w.calls.filter((c) => c === 'patchItem').length, 0, 'never patched over the Zotero edit');
  notes = await readNotes(dir, ID);
  assert.ok(notes.note.conflict?.at, 'conflict raised again');
  assert.equal(notes.note.zoteroEdited, true);
  assert.equal(notes.cardMemos.c3, 'third');
  assert.equal(r.pending, 1);
  assert.deepEqual((await readPending(dir, ID)).ops.map((o) => o.op), ['upsert-note']);

  // keep-zotero again: still protected
  await resolveNoteConflict(dir, ID, 'keep-zotero');
  await setCardMemo(dir, ID, 'c3', 'third!');
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.items.get(key).data.note, '<p>zotero edit</p>');

  // overwrite clears zoteroEdited and writes
  await resolveNoteConflict(dir, ID, 'overwrite');
  notes = await readNotes(dir, ID);
  assert.equal(notes.note.conflict, null);
  assert.ok(!notes.note.zoteroEdited);
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.items.get(key).data.note, noteHtml(cards, { c1: 'mine', c2: 'second', c3: 'third!' }));
  await setCardMemo(dir, ID, 'c1', 'mine2');
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.items.get(key).data.note, noteHtml(cards, { c1: 'mine2', c2: 'second', c3: 'third!' }), 'normal edits write again after overwrite');
  await assert.rejects(() => resolveNoteConflict(dir, ID, 'bogus'));
});

test('local delete of a highlight edited in Zotero → not deleted, restored with Zotero values', async () => {
  const dir = await tmp();
  const h = await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: 'orig' });
  const w = fakeWriter();
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const key = (await readNotes(dir, ID)).highlights[0].zoteroKey;
  const it = w.items.get(key);
  it.data.annotationComment = 'zotero edit';
  it.version = w.bump();
  await removeHighlight(dir, ID, h.id);
  const r = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r.pending, 0);
  assert.equal(w.items.has(key), true);
  assert.equal(w.calls.filter((c) => c === 'deleteItem').length, 0);
  const notes = await readNotes(dir, ID);
  assert.deepEqual(notes.tombstones, []);
  assert.equal(notes.highlights.length, 1);
  const back = notes.highlights[0];
  assert.equal(back.id, h.id);
  assert.equal(back.zoteroKey, key);
  assert.equal(back.zoteroVersion, it.version);
  assert.equal(back.comment, 'zotero edit');
  assert.deepEqual(back.sentenceIds, ['p1-s1']);
  assert.deepEqual(back.conflict.mine, { deleted: true });
  assert.ok(back.conflict.at);
  assert.equal(notes.zoteroAnnotations.length, 0);
});

test('created item: version missing and getItem fails → key still saved, no duplicate', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '' });
  const w = fakeWriter();
  w.noVersionOnCreate = true;
  w.fail.getItem = new ZoteroWriteError('offline', 'down');
  w.fail.listChildren = new ZoteroWriteError('offline', 'down'); // pull would otherwise fill the version
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  const local = (await readNotes(dir, ID)).highlights[0];
  assert.ok(local.zoteroKey);
  assert.equal(local.zoteroVersion, null);
  delete w.fail.getItem;
  delete w.fail.listChildren;
  await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(w.calls.filter((c) => c === 'createItems').length, 1);
  assert.equal(w.items.size, 1);
});

test('noteHtml escapes HTML and includes only cards with memos', () => {
  const html = noteHtml(cards, { c1: 'a < b & "c"\nnext', c2: '   ', c3: "it's" });
  assert.equal(
    html,
    '<h1>Paper Reader 메모</h1>'
      + '<h2>1. Why &lt;this&gt;?</h2><p>a &lt; b &amp; &quot;c&quot;<br>next</p>'
      + '<h2>3. How &amp; when?</h2><p>it&#39;s</p>',
  );
  assert.equal(noteHtml(cards, {}), '<h1>Paper Reader 메모</h1>');
});

test('noteHtml keeps memos of cards no longer in the digest under "이전 요약의 메모"', () => {
  const now = [{ id: 'c1-r1', question: 'New first?' }];
  const html = noteHtml(now, { c3: 'old <memo>\nline2', 'c1-r1': 'fresh', c4: '  ', c5: 'another' });
  assert.equal(
    html,
    '<h1>Paper Reader 메모</h1>'
      + '<h2>1. New first?</h2><p>fresh</p>'
      + '<h2>이전 요약의 메모</h2><p>old &lt;memo&gt;<br>line2</p><p>another</p>',
  );
  // only old memos: still a note
  assert.equal(noteHtml(now, { c3: 'x' }), '<h1>Paper Reader 메모</h1><h2>이전 요약의 메모</h2><p>x</p>');
});

test('setCardMemo with empty text removes the memo', async () => {
  const dir = await tmp();
  await setCardMemo(dir, ID, 'c1', 'x');
  await setCardMemo(dir, ID, 'c1', '');
  assert.deepEqual((await readNotes(dir, ID)).cardMemos, {});
});

test('concurrent addHighlight calls on same paper both persist', async () => {
  const dir = await tmp();
  const w = fakeWriter();
  const results = await Promise.all([
    addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ffd400', comment: '1' }),
    addHighlight(dir, ID, { sentenceIds: ['p1-s2'], color: '#ffd400', comment: '2' }),
    syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE }),
    setCardMemo(dir, ID, 'c1', 'memo'),
    addHighlight(dir, ID, { sentenceIds: ['p2-s1'], color: '#ffd400', comment: '3' }),
  ]);
  assert.equal(new Set([results[0].id, results[1].id, results[4].id]).size, 3);
  const notes = await readNotes(dir, ID);
  assert.deepEqual(notes.highlights.map((h) => h.comment).sort(), ['1', '2', '3']);
  assert.equal(notes.cardMemos.c1, 'memo');
  const pendingIds = (await readPending(dir, ID)).ops.map((o) => o.id ?? o.op);
  const unsent = notes.highlights.filter((h) => !h.zoteroKey).map((h) => h.id);
  for (const id of unsent) assert.ok(pendingIds.includes(id));
});

test('addHighlight validates input', async () => {
  const dir = await tmp();
  await assert.rejects(() => addHighlight(dir, ID, { sentenceIds: [], color: '#ffd400' }));
  await assert.rejects(() => addHighlight(dir, ID, { sentenceIds: [1], color: '#ffd400' }));
});

test('unlinked paper: status local, no message, pending kept, writer untouched (even if Zotero is off)', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ff6666', comment: 'c' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w = fakeWriter();
  const before = (await readPending(dir, ID)).ops.length;
  assert.ok(before >= 2);
  for (const info of [ONLINE, { running: false, message: 'Zotero가 꺼져 있습니다.' }]) {
    for (const z of [undefined, null, { itemKey: null, attachmentKey: null }]) {
      const src = { ...source, zotero: z };
      const r = await syncPaper(dir, ID, { source: src, cards, writer: w, serverInfo: info });
      assert.deepEqual(r, { status: 'local', pending: before, message: null, failed: 0, failedMessage: null });
    }
  }
  assert.deepEqual(w.calls, []);
  assert.equal((await readPending(dir, ID)).ops.length, before);
});

test('memos queued while local are sent after the paper gets linked', async () => {
  const dir = await tmp();
  await addHighlight(dir, ID, { sentenceIds: ['p1-s1'], color: '#ff6666', comment: 'a' });
  await addHighlight(dir, ID, { sentenceIds: ['p2-s1'], color: '#ff6666', comment: 'b' });
  await setCardMemo(dir, ID, 'c1', 'memo');
  const w = fakeWriter();
  const r1 = await syncPaper(dir, ID, { source: { ...source, zotero: undefined }, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r1.status, 'local');
  const r2 = await syncPaper(dir, ID, { source, cards, writer: w, serverInfo: ONLINE });
  assert.equal(r2.status, 'connected');
  assert.equal(r2.pending, 0);
  const notes = await readNotes(dir, ID);
  assert.equal(notes.highlights.filter((h) => h.zoteroKey).length, 2);
  assert.ok(notes.note.zoteroKey, 'card memo note created');
  assert.equal(w.calls.filter((c) => c === 'createItems').length >= 1, true);
});
