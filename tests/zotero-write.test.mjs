import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getServerInfo, createZoteroWriter, ZoteroWriteError, fileAuthStore,
} from '../src/zotero/write.mjs';

const CFG = { zotero: { baseUrl: 'http://127.0.0.1:23119/' } };
const SID = 'server-A';

function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// handler(url, init) -> response | undefined (default: /api/ root info)
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const r = await handler(u, init, calls);
    if (r) return r;
    if (u.endsWith('/api/')) return res(200, '', { 'Zotero-Server-ID': SID, 'X-Zotero-Version': '10.0.1' });
    throw new Error(`unexpected ${u}`);
  };
  fn.calls = calls;
  return fn;
}

function memStore(init = {}) {
  const m = { ...init };
  return {
    m,
    get: async (id) => m[id] ?? null,
    set: async (id, k) => { m[id] = k; },
    clear: async (id) => { delete m[id]; },
  };
}

const okCreate = () => res(200, { success: { 0: 'ABCD1234' }, successful: { 0: { key: 'ABCD1234', version: 5 } }, unchanged: {}, failed: {} });
const isAuthz = (u) => u.endsWith('/api/local/authorize');
const isItems = (u) => u.endsWith('/api/users/0/items');

async function rejectsCode(p, code) {
  await assert.rejects(p, (e) => e instanceof ZoteroWriteError && e.code === code);
}

test('authorize remember:true stores key; write sends both headers and raw result', async () => {
  const store = memStore();
  const f = fakeFetch((u) => {
    if (isAuthz(u)) return res(200, { key: 'K1', remember: true }, { 'Zotero-Server-ID': SID });
    if (isItems(u)) return okCreate();
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: store });
  assert.deepEqual(await w.authorize(), { remember: true });
  const az = f.calls.find((c) => isAuthz(c.url));
  assert.equal(az.method, 'POST');
  assert.equal(az.headers['Zotero-Server-ID'], SID);
  assert.deepEqual(JSON.parse(az.body), { appName: 'Paper Reader' });
  assert.equal(await store.get(SID), 'K1');
  const r = await w.createItems([{ itemType: 'annotation' }]);
  assert.deepEqual(r.success, { 0: 'ABCD1234' });
  assert.equal(r.successful[0].version, 5);
  assert.deepEqual(r.failed, {});
  const wr = f.calls.find((c) => isItems(c.url));
  assert.equal(wr.headers['Zotero-API-Key'], 'K1');
  assert.equal(wr.headers['Zotero-Server-ID'], SID);
  assert.deepEqual(JSON.parse(wr.body), [{ itemType: 'annotation' }]);
});

test('write without key throws needs-auth and never calls authorize', async () => {
  const f = fakeFetch((u) => { if (isItems(u)) return okCreate(); });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  await rejectsCode(w.createItems([{}]), 'needs-auth');
  assert.ok(!f.calls.some((c) => isAuthz(c.url)));
  assert.ok(!f.calls.some((c) => isItems(c.url)));
});

test('remember:false key is used once; next write throws needs-auth', async () => {
  const store = memStore();
  const f = fakeFetch((u) => {
    if (isAuthz(u)) return res(200, { key: 'ONCE', remember: false });
    if (isItems(u)) return okCreate();
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: store });
  assert.deepEqual(await w.authorize(), { remember: false });
  assert.equal(await store.get(SID), null);
  await w.createItems([{}]);
  assert.equal(f.calls.find((c) => isItems(c.url)).headers['Zotero-API-Key'], 'ONCE');
  await rejectsCode(w.createItems([{}]), 'needs-auth');
});

test('write 401 clears stored key and throws needs-auth without re-authorizing', async () => {
  const store = memStore({ [SID]: 'STALE' });
  const f = fakeFetch((u) => { if (isItems(u)) return res(401, '', { 'WWW-Authenticate': 'x' }); });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: store });
  await rejectsCode(w.createItems([{}]), 'needs-auth');
  assert.equal(await store.get(SID), null);
  assert.ok(!f.calls.some((c) => isAuthz(c.url)));
});

test('authorize 403 -> denied', async () => {
  const f = fakeFetch((u) => { if (isAuthz(u)) return res(403, { denied: true }); });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  await rejectsCode(w.authorize(), 'denied');
});

test('authorize 429 -> rate-limited with retryAfter', async () => {
  const f = fakeFetch((u) => { if (isAuthz(u)) return res(429, '', { 'Retry-After': '12' }); });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  await assert.rejects(w.authorize(), (e) => e.code === 'rate-limited' && e.retryAfter === 12 && e.status === 429);
});

test('412 with different Zotero-Server-ID -> server-changed and old key cleared', async () => {
  const store = memStore({ [SID]: 'K' });
  const f = fakeFetch((u) => { if (isItems(u)) return res(412, '', { 'Zotero-Server-ID': 'server-B' }); });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: store });
  await rejectsCode(w.createItems([{}]), 'server-changed');
  assert.equal(await store.get(SID), null);
});

test('412 with same Zotero-Server-ID on patch -> http 412 version conflict, key kept', async () => {
  const store = memStore({ [SID]: 'K' });
  const f = fakeFetch((u) => { if (u.includes('/items/ABCD1234')) return res(412, '', { 'Zotero-Server-ID': SID }); });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: store });
  await assert.rejects(w.patchItem('ABCD1234', 3, { comment: 'x' }), (e) => e.code === 'http' && e.status === 412);
  assert.equal(await store.get(SID), 'K');
  const c = f.calls.find((x) => x.method === 'PATCH');
  assert.equal(c.headers['If-Unmodified-Since-Version'], '3');
});

test('patchItem returns new version; deleteItem sends version header', async () => {
  const store = memStore({ [SID]: 'K' });
  const f = fakeFetch((u, init) => {
    if (init.method === 'PATCH') return res(204, '', { 'Last-Modified-Version': '9' });
    if (init.method === 'DELETE') return res(204, '');
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: store });
  assert.equal(await w.patchItem('ABCD1234', 8, { comment: 'y' }), 9);
  await w.deleteItem('ABCD1234', 9);
  const d = f.calls.find((x) => x.method === 'DELETE');
  assert.equal(d.headers['If-Unmodified-Since-Version'], '9');
  assert.equal(d.headers['Zotero-API-Key'], 'K');
});

test('fetch throws -> offline', async () => {
  const f = async () => { throw new TypeError('fetch failed'); };
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  await rejectsCode(w.authorize(), 'offline');
  await rejectsCode(w.createItems([{}]), 'offline');
  assert.equal((await getServerInfo(CFG, { fetchImpl: f })).running, false);
});

test('Zotero 9 (no Zotero-Server-ID) -> not writable; writes throw readonly', async () => {
  const f = fakeFetch((u) => { if (u.endsWith('/api/')) return res(200, ''); });
  const info = await getServerInfo(CFG, { fetchImpl: f });
  assert.deepEqual(info, { running: true, serverId: null, version: null, writable: false });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore({ x: 'k' }) });
  await rejectsCode(w.createItems([{}]), 'readonly');
  await rejectsCode(w.authorize(), 'readonly');
});

test('Zotero 9: reads work (no Server-ID header when none reported), writes still readonly', async () => {
  const f = fakeFetch((u) => {
    if (u.endsWith('/api/')) return res(200, '', { 'X-Zotero-Version': '9.0.2' });
    if (u.includes('/children')) return res(200, [{ key: 'A' }], { 'Last-Modified-Version': '3' });
    if (u.includes('/items/ABCD1234')) return res(200, { key: 'ABCD1234', version: 2 });
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  assert.deepEqual(await w.getItem('ABCD1234'), { key: 'ABCD1234', version: 2 });
  assert.deepEqual(await w.listChildren('P', undefined, { itemType: 'annotation' }),
    { items: [{ key: 'A' }], libraryVersion: 3, notModified: false });
  for (const c of f.calls.filter((x) => !x.url.endsWith('/api/'))) {
    assert.equal(c.headers['Zotero-Server-ID'], undefined);
  }
  await rejectsCode(w.createItems([{}]), 'readonly');
  await rejectsCode(w.patchItem('ABCD1234', 2, {}), 'readonly');

  const f9id = fakeFetch((u) => {
    if (u.endsWith('/api/')) return res(200, '', { 'Zotero-Server-ID': SID, 'X-Zotero-Version': '9.0.2' });
    if (u.includes('/items/ABCD1234')) return res(200, { key: 'ABCD1234' });
  });
  const w9 = createZoteroWriter(CFG, { fetchImpl: f9id, authStore: memStore() });
  assert.deepEqual(await w9.getItem('ABCD1234'), { key: 'ABCD1234' });
  assert.equal(f9id.calls.at(-1).headers['Zotero-Server-ID'], SID);
});

test('every request carries a timeout signal; abort/timeout -> offline', async () => {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try {
    const f = fakeFetch((u, init) => {
      assert.ok(init.signal instanceof AbortSignal, `signal on ${u}`);
      if (isAuthz(u)) return res(200, { key: 'K', remember: true });
      if (isItems(u)) return okCreate();
    });
    const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
    await getServerInfo(CFG, { fetchImpl: f });
    await w.authorize();
    await w.createItems([{}]);
    assert.deepEqual(seen, [10000, 10000, 120000, 10000]);
  } finally {
    AbortSignal.timeout = orig;
  }

  for (const name of ['AbortError', 'TimeoutError']) {
    const hung = async () => { throw new DOMException('aborted', name); };
    const w = createZoteroWriter(CFG, { fetchImpl: hung, authStore: memStore({ [SID]: 'K' }) });
    await rejectsCode(w.getItem('X'), 'offline');
    await rejectsCode(w.listChildren('X'), 'offline');
    await rejectsCode(w.createItems([{}]), 'offline');
    await rejectsCode(w.authorize(), 'offline');
    assert.equal((await getServerInfo(CFG, { fetchImpl: hung })).running, false);
    // info fetched, then the write itself hangs
    let n = 0;
    const late = fakeFetch((u) => {
      if (!u.endsWith('/api/') && n++ >= 0) throw new DOMException('timed out', name);
    });
    const w2 = createZoteroWriter(CFG, { fetchImpl: late, authStore: memStore({ [SID]: 'K' }) });
    await rejectsCode(w2.patchItem('X', 1, {}), 'offline');
    await rejectsCode(w2.getItem('X'), 'offline');
  }
});

test('getServerInfo reads id and version; major < 10 is not writable', async () => {
  const f10 = fakeFetch(() => undefined);
  assert.deepEqual(await getServerInfo(CFG, { fetchImpl: f10 }),
    { running: true, serverId: SID, version: '10.0.1', writable: true });
  const f9 = fakeFetch((u) => res(200, '', { 'Zotero-Server-ID': SID, 'X-Zotero-Version': '9.0.2' }));
  const i9 = await getServerInfo(CFG, { fetchImpl: f9 });
  assert.equal(i9.writable, false);
  const w = createZoteroWriter(CFG, { fetchImpl: f9, authStore: memStore() });
  await rejectsCode(w.createItems([{}]), 'readonly');
});

test('listChildren sends If-Modified-Since-Version and maps 304', async () => {
  const f = fakeFetch((u) => {
    if (u.includes('/children')) return res(304, '', { 'Last-Modified-Version': '40' });
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  const r = await w.listChildren('PARENT12', 40);
  assert.deepEqual(r, { items: [], libraryVersion: 40, notModified: true });
  const c = f.calls.find((x) => x.url.includes('/children'));
  assert.equal(c.url, 'http://127.0.0.1:23119/api/users/0/items/PARENT12/children?format=json');
  assert.equal(c.headers['If-Modified-Since-Version'], '40');
});

test('listChildren appends itemType filter when given (annotations are omitted otherwise)', async () => {
  const f = fakeFetch((u) => {
    if (u.includes('/children')) return res(200, [], { 'Last-Modified-Version': '7' });
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  await w.listChildren('ATT1', undefined, { itemType: 'annotation' });
  await w.listChildren('ITEM1', 5, { itemType: 'note || attachment' });
  const urls = f.calls.filter((x) => x.url.includes('/children'));
  assert.equal(urls[0].url, 'http://127.0.0.1:23119/api/users/0/items/ATT1/children?format=json&itemType=annotation');
  assert.equal(urls[0].headers['If-Modified-Since-Version'], undefined);
  assert.equal(urls[1].url, 'http://127.0.0.1:23119/api/users/0/items/ITEM1/children?format=json&itemType=note%20%7C%7C%20attachment');
  assert.equal(urls[1].headers['If-Modified-Since-Version'], '5');
});

test('listChildren returns items and libraryVersion; getItem 404 -> null', async () => {
  const f = fakeFetch((u) => {
    if (u.includes('/children')) return res(200, [{ key: 'A' }], { 'Last-Modified-Version': '41' });
    if (u.includes('/items/MISSING1')) return res(404, '');
    if (u.includes('/items/ABCD1234')) return res(200, { key: 'ABCD1234' });
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  assert.deepEqual(await w.listChildren('P'), { items: [{ key: 'A' }], libraryVersion: 41, notModified: false });
  assert.equal(await w.getItem('MISSING1'), null);
  assert.deepEqual(await w.getItem('ABCD1234'), { key: 'ABCD1234' });
});

test('fileAuthStore writes mode 0o600 and round-trips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-auth-'));
  const file = path.join(dir, 'sub', 'auth.json');
  const s = fileAuthStore(file);
  assert.equal(await s.get('a'), null);
  await s.set('a', 'KA');
  await s.set('b', 'KB');
  assert.equal(await s.get('a'), 'KA');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await s.clear('a');
  assert.equal(await s.get('a'), null);
  assert.equal(await s.get('b'), 'KB');
  assert.equal((await fs.readdir(path.dirname(file))).length, 1);
  await fs.rm(dir, { recursive: true });
});

test('remember:false key survives offline and version-conflict 412; consumed on success', async () => {
  let mode = 'offline';
  const f = fakeFetch((u, init) => {
    if (isAuthz(u)) return res(200, { key: 'ONCE', remember: false });
    if (init.method === 'PATCH') {
      if (mode === 'offline') throw new TypeError('down');
      if (mode === '412') return res(412, '', { 'Zotero-Server-ID': SID });
      if (mode === '500') return res(500, '');
      return res(204, '', { 'Last-Modified-Version': '3' });
    }
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  await w.authorize();
  await rejectsCode(w.patchItem('ABCD1234', 1, {}), 'offline');
  mode = '412';
  await rejectsCode(w.patchItem('ABCD1234', 1, {}), 'http');
  mode = '500';
  await rejectsCode(w.patchItem('ABCD1234', 1, {}), 'http');
  mode = 'ok';
  assert.equal(await w.patchItem('ABCD1234', 1, {}), 3);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').at(-1).headers['Zotero-API-Key'], 'ONCE');
  await rejectsCode(w.patchItem('ABCD1234', 3, {}), 'needs-auth');
});

test('patchItem returns null when Last-Modified-Version is missing or invalid', async () => {
  const f = fakeFetch((u, init) => { if (init.method === 'PATCH') return res(204, ''); });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore({ [SID]: 'K' }) });
  assert.equal(await w.patchItem('ABCD1234', 1, {}), null);
});

test('authorize 200 with missing key or bad JSON -> http error', async () => {
  const bad = (body) => {
    const r = res(200, body);
    return r;
  };
  const f1 = fakeFetch((u) => { if (isAuthz(u)) return bad({ remember: true }); });
  await rejectsCode(createZoteroWriter(CFG, { fetchImpl: f1, authStore: memStore() }).authorize(), 'http');
  const f2 = fakeFetch((u) => {
    if (isAuthz(u)) { const r = res(200, ''); r.json = async () => { throw new SyntaxError('x'); }; return r; }
  });
  await rejectsCode(createZoteroWriter(CFG, { fetchImpl: f2, authStore: memStore() }).authorize(), 'http');
});

test('resetInfo clears cached server info but keeps the single-use key', async () => {
  let version = '10.0.1';
  const f = fakeFetch((u) => {
    if (isAuthz(u)) return res(200, { key: 'ONCE', remember: false });
    if (isItems(u)) return okCreate();
    if (u.endsWith('/api/')) return res(200, '', { 'Zotero-Server-ID': SID, 'X-Zotero-Version': version });
  });
  const w = createZoteroWriter(CFG, { fetchImpl: f, authStore: memStore() });
  await w.authorize();
  assert.equal(await w.serverId(), SID);
  const rootCalls = () => f.calls.filter((c) => c.url.endsWith('/api/')).length;
  const before = rootCalls();
  await w.serverId();
  assert.equal(rootCalls(), before); // cached
  w.resetInfo();
  version = '9.0.0';
  await rejectsCode(w.serverId(), 'readonly'); // refetched
  assert.equal(rootCalls(), before + 1);
  w.resetInfo();
  version = '10.0.1';
  await w.createItems([{}]); // onceKey survived resetInfo
  const used = f.calls.find((c) => isItems(c.url));
  assert.equal(used.headers['Zotero-API-Key'], 'ONCE');
});
