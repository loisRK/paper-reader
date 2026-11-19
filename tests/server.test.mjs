import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/reader/server.mjs';
import { folderPaperId } from '../src/library/scan.mjs';
import { fullDigest } from './fixtures/digest-fixture.mjs';

let dir, server, base;
const calls = [];
const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 201 }; };

const source = {
  id: 'p1',
  zotero: { itemKey: 'ITEM0001', attachmentKey: 'ATT00001' },
  meta: { title: 'T1', journal: 'J1', date: '2025-01-01' },
  pages: [{ page: 1 }],
  sentences: { 'p1-s1': { text: 'a', page: 1 }, 'p1-s2': { text: 'b', page: 1 } },
};
const digest = {
  version: 1, paperId: 'p1',
  takeaway: { text: 't', evidence: ['p1-s1'], why: 'w' },
  cards: [{
    id: 'c1', section: 'motivation', question: 'q', answer: 'a', bridge: '',
    items: [
      { kind: 'claim', text: 'ok', evidence: ['p1-s1'] },
      { kind: 'claim', text: 'bad', evidence: ['p9-s9'] },
    ],
  }, { id: 'c2', section: 'gap', question: 'q', answer: 'a', bridge: '', items: [{ kind: 'opinion', text: 'o', evidence: [] }] }],
  glossary: [],
};
const search = { query: 'q', papers: [{ n: 1, title: 'X', doi: '10.1/x', authors: ['A B'], journal: 'J', issn: [], publicationDate: '2025-01-01', oaPdfUrl: null }] };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-server-'));
  await fs.mkdir(path.join(dir, 'p1'));
  await fs.writeFile(path.join(dir, 'p1', 'source.json'), JSON.stringify(source));
  await fs.writeFile(path.join(dir, 'p1', 'digest.json'), JSON.stringify(digest));
  await fs.mkdir(path.join(dir, 'p2'));
  await fs.writeFile(path.join(dir, 'p2', 'source.json'), JSON.stringify({ ...source, id: 'p2', meta: { title: 'T2' } }));
  await fs.writeFile(path.join(dir, 'p2', 'digest.json'), '{broken');
  await fs.mkdir(path.join(dir, 'p3'));
  await fs.writeFile(path.join(dir, 'p3', 'source.json'), JSON.stringify({ id: 'p3', meta: { title: 'T3' } }));
  await fs.mkdir(path.join(dir, '_search'));
  await fs.writeFile(path.join(dir, '_search', '2026-01-01-a.json'), JSON.stringify(search));
  await fs.writeFile(path.join(dir, '_search', '2026-02-01-b.json'), JSON.stringify(search));
  await fs.writeFile(path.join(dir, 'secret.json'), '{}');
  server = createServer({ outputDir: dir, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const put = (p, body) => fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('lists papers with read progress', async () => {
  await put('/api/papers/p1/progress', { read: ['c1', 'zzz'], mode: '3min', focus: false });
  const { papers: list, folders } = await (await fetch(`${base}/api/papers`)).json();
  assert.deepEqual(folders, []);
  const p1 = list.find((p) => p.id === 'p1');
  assert.deepEqual(p1, { id: 'p1', example: false, title: 'T1', journal: 'J1', date: '2025-01-01', hasDigest: true, cardsRead: 1, cardsTotal: 2, state: 'digest', origin: 'zotero', linked: true });
  assert.equal(list.find((p) => p.id === 'p3').state, 'extracted');
  assert.equal(list.find((p) => p.id === 'p3').linked, false);
  const p2 = list.find((p) => p.id === 'p2');
  assert.equal(p2.cardsTotal, 0);
  assert.ok(!list.some((p) => p.id === '_search'));
});

test('paper endpoint returns validated digest and problems', async () => {
  const body = await (await fetch(`${base}/api/papers/p1`)).json();
  assert.ok(body.problems.includes('c1: 근거 없는 claim 제거 – bad'));
  // An old digest's opinion is dropped from the cards and shown as a problem in the banner.
  assert.ok(body.problems.includes('c2: 해석·의견 항목은 쓰지 않습니다 – o'));
  assert.deepEqual(body.digest.cards[1].items, []);
  assert.equal(body.digest.cards.length, 2);
  assert.equal(body.links.zoteroPdf, 'zotero://open-pdf/library/items/ATT00001');
  assert.equal(body.links.zoteroItem, 'zotero://select/library/items/ITEM0001');
  assert.equal(body.source.id, 'p1');
});

test('broken digest.json still returns 200 with problem', async () => {
  const res = await fetch(`${base}/api/papers/p2`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.problems.some((m) => m.startsWith('digest.json을 읽을 수 없습니다: ')));
});

test('path traversal id is rejected with 400', async () => {
  const res = await fetch(`${base}/api/papers/..%2Fsecret`);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
  assert.equal((await fetch(`${base}/api/papers/nope`)).status, 404);
});

test('progress round-trips', async () => {
  const prog = { read: ['c2'], mode: '10min', focus: true };
  assert.equal((await put('/api/papers/p1/progress', prog)).status, 204);
  assert.deepEqual((await (await fetch(`${base}/api/papers/p1`)).json()).progress, prog);
  assert.equal((await put('/api/papers/p1/progress', { read: 'x', mode: '3min', focus: true })).status, 400);
  assert.equal((await put('/api/papers/p1/progress', { read: [], mode: '5min', focus: true })).status, 400);
  assert.equal((await put('/api/papers/nope/progress', prog)).status, 404);
});

test('searches list and read', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/searches`)).json(), ['2026-02-01-b', '2026-01-01-a']);
  assert.equal((await (await fetch(`${base}/api/searches/2026-01-01-a`)).json()).query, 'q');
  assert.equal((await fetch(`${base}/api/searches/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/searches/..%2Fp1%2Fsource`)).status, 400);
});

test('register uses injected fetch and handles unknowns', async () => {
  const ok = await post('/api/register', { search: '2026-01-01-a', n: 1 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.ok(calls[0].url.endsWith('/connector/saveItems'));
  assert.equal((await post('/api/register', { search: 'zzz', n: 1 })).status, 404);
  const bad = await post('/api/register', { search: '2026-01-01-a', n: 7 });
  assert.equal(bad.status, 404);
  assert.equal((await bad.json()).error, '7번 논문이 이 검색 결과에 없습니다.');
});

test('serves index.html at / and blocks static traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  const port = server.address().port;
  const rawGet = (target) => new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let buf = ''; s.on('data', (d) => { buf += d; }); s.on('end', () => resolve(buf));
    });
  });
  for (const target of ['/../../package.json', '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/..%5c..%5cpackage.json']) {
    const raw = await rawGet(target);
    assert.match(raw, /^HTTP\/1.1 (400|404)/, target);
    assert.ok(!raw.includes('"name": "paper-reader"'), `${target} leaked package.json`);
  }
});

test('oversized body returns 413', async () => {
  const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal(res.status, 413);
});

test('rejects non-JSON content type with 415', async () => {
  const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"search":"2026-01-01-a","n":1}' });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error, 'Content-Type은 application/json이어야 합니다.');
  const ok = await post('/api/register', { search: '2026-01-01-a', n: 1 });
  assert.equal(ok.status, 200);
});

test('rejects foreign Host header with 403', async () => {
  const { default: http } = await import('node:http');
  const status = (p, host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(await status('/api/papers', 'evil.example'), 403);
  assert.equal(await status('/', 'evil.example'), 403);
  assert.equal(await status('/api/papers', `localhost:${server.address().port}`), 200);
});

test('missing zotero keys give null links', async () => {
  const body = await (await fetch(`${base}/api/papers/p3`)).json();
  assert.deepEqual(body.links, { zoteroPdf: null, pdf: false, zoteroItem: null });
});

test('Korean search slug round-trips: runSearch file → list → read → register', async () => {
  const { runSearch } = await import('../src/search/run.mjs');
  const { DEFAULTS } = await import('../src/config.mjs');
  const kdir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-ko-'));
  const cfg = { ...structuredClone(DEFAULTS), outputDir: kdir, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } };
  const work = { openalexId: 'W1', doi: '10.1/k', title: 'K', abstract: '', authors: ['A B'], journal: 'J', issn: [], publicationDate: '2026-01-10', citedBy: 3, countsByYear: [{ year: 2026, count: 3 }], topic: null, oaPdfUrl: null };
  const r = await runSearch('이상 탐지', cfg, {
    now: new Date('2026-11-18T00:00:00Z'),
    search: async () => [work],
    verify: async () => ({ ok: true, reason: null, verification: { crossrefType: 'journal-article', doiResolves: true } }),
    metricsIndex: { sjr: new Map(), mjl: new Map() },
  });
  const name = path.basename(r.path, '.json');
  assert.equal(name, '2026-11-18-이상-탐지');
  await fs.writeFile(path.join(kdir, '_search', 'bad name!.json'), '{}');
  const kcalls = [];
  const ks = createServer(cfg, { fetchImpl: async (url) => { kcalls.push(url); return { status: 201 }; } });
  await new Promise((res) => ks.listen(0, '127.0.0.1', res));
  const kbase = `http://127.0.0.1:${ks.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${kbase}/api/searches`)).json(), [name]);
    const got = await fetch(`${kbase}/api/searches/${encodeURIComponent(name)}`);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).query, '이상 탐지');
    const reg = await fetch(`${kbase}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ search: name, n: r.papers[0].n }) });
    assert.equal(reg.status, 200);
    assert.equal(kcalls.length, 1);
  } finally {
    ks.close();
    await fs.rm(kdir, { recursive: true, force: true });
  }
});

test('server entry point prints a one-line Korean error and exits 1 on bad config', async () => {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-entry-'));
  await fs.writeFile(path.join(cwd, 'paper-reader.config.json'), '{ broken');
  const entry = fileURLToPath(new URL('../src/reader/server.mjs', import.meta.url));
  const r = await new Promise((resolve) => execFile(process.execPath, [entry], { cwd }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr })));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^설정 파일을 읽지 못했습니다: /);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  await fs.rm(cwd, { recursive: true, force: true });
});

// ---- notes / highlights routes (fake Zotero injected; never hits a real one) ----
const rect = [[10, 10, 50, 20]];
const nsource = {
  id: 'n1',
  zotero: { itemKey: 'ITEM0001', attachmentKey: 'ATT00001' },
  meta: { title: 'N1' },
  pages: [{ page: 1 }, { page: 2 }],
  sentences: {
    'n1-s1': { text: 'a', page: 1, rects: rect, pdfRects: rect },
    'n1-s2': { text: 'b', page: 1, rects: rect, pdfRects: rect },
    'n1-s10': { text: 'c', page: 1, rects: rect, pdfRects: rect },
    'n1-s11': { text: 'd', page: 2, rects: rect, pdfRects: rect },
    'n1-s12': { text: 'e', page: 2 },
  },
};

async function notesServer(t, extra = {}) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-notes-'));
  const ex = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-notes-ex-'));
  for (const [root, id, src] of [[d, 'n1', nsource], [ex, 'exa', { ...nsource, id: 'exa' }]]) {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, 'source.json'), JSON.stringify(src));
  }
  await fs.writeFile(path.join(d, 'n1', 'digest.json'), JSON.stringify({ ...digest, paperId: 'n1', takeaway: { text: 't', evidence: ['n1-s1'], why: 'w' }, cards: [{ id: 'c1', section: 'motivation', question: 'q', answer: 'a', bridge: '', items: [] }] }));
  const zcalls = { info: 0, reset: 0, authorize: 0 };
  const zotero = {
    getServerInfo: async () => { zcalls.info += 1; return { running: false, serverId: null, version: null, writable: false }; },
    writer: {
      resetInfo: () => { zcalls.reset += 1; },
      authorize: async () => { zcalls.authorize += 1; if (extra.authorizeError) throw Object.assign(new Error('x'), { code: extra.authorizeError }); return { remember: true }; },
    },
  };
  const s = createServer({ outputDir: d, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { examplesDir: ex, zotero });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  t.after(async () => { s.close(); await fs.rm(d, { recursive: true, force: true }); await fs.rm(ex, { recursive: true, force: true }); });
  const req = (method, p, body) => fetch(b + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { b, req, zcalls, dir: d, server: s };
}

test('GET notes returns status and runs sync once', async (t) => {
  const { req, zcalls } = await notesServer(t);
  const r = await req('GET', '/api/papers/n1/notes');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.highlights, []);
  assert.deepEqual(body.cardMemos, {});
  assert.deepEqual(body.zoteroAnnotations, []);
  assert.equal(body.status, 'offline');
  assert.equal(body.pending, 0);
  assert.equal(body.failed, 0);
  assert.equal(body.failedMessage, null);
  assert.equal(body.needsReextract, true);
  assert.ok('pending' in body && 'message' in body && 'note' in body);
  assert.equal(zcalls.info, 1);
  assert.equal(zcalls.reset, 1);
  assert.equal((await req('GET', '/api/papers/nope/notes')).status, 404);
  assert.equal((await req('GET', '/api/papers/..%2Fx/notes')).status, 400);
});

test('POST highlights validates sentenceIds exist and color is a Zotero color', async (t) => {
  const { req } = await notesServer(t);
  const url = '/api/papers/n1/highlights';
  assert.equal((await req('POST', url, { sentenceIds: [] })).status, 400);
  assert.equal((await req('POST', url, { sentenceIds: 'n1-s1' })).status, 400);
  assert.equal((await req('POST', url, { sentenceIds: ['zzz'] })).status, 400);
  assert.equal((await req('POST', url, { sentenceIds: Array.from({ length: 21 }, () => 'n1-s1') })).status, 400);
  assert.equal((await req('POST', url, { sentenceIds: ['n1-s1'], color: '#123456' })).status, 400);
  assert.equal((await req('POST', url, { sentenceIds: ['n1-s1'], comment: 'x'.repeat(2001) })).status, 400);
  assert.equal((await req('POST', url, { sentenceIds: ['n1-s1'], comment: 5 })).status, 400);
  const ok = await req('POST', url, { sentenceIds: ['n1-s10', 'n1-s2', 'n1-s1', 'n1-s2'], color: '#ff6666', comment: 'hi' });
  assert.equal(ok.status, 201);
  const h = await ok.json();
  assert.deepEqual(h.sentenceIds, ['n1-s1', 'n1-s2', 'n1-s10']); // document order, deduped
  assert.equal(h.color, '#ff6666');
  const notes = await (await req('GET', '/api/papers/n1/notes')).json();
  assert.equal(notes.highlights.length, 1);
});

test('POST highlights pre-validates against Zotero conversion (409 re-extract / 400 multi-page)', async (t) => {
  const { req, dir } = await notesServer(t);
  const url = '/api/papers/n1/highlights';
  const multi = await req('POST', url, { sentenceIds: ['n1-s1', 'n1-s11'] });
  assert.equal(multi.status, 400);
  assert.match((await multi.json()).error, /한 페이지/);
  const re = await req('POST', url, { sentenceIds: ['n1-s12'] });
  assert.equal(re.status, 409);
  assert.equal((await re.json()).error, '원문을 다시 추출해야 Zotero에 보낼 수 있습니다: npm run extract -- n1');
  await assert.rejects(fs.access(path.join(dir, 'n1', 'notes.json'))); // nothing stored
});

test('GET notes on example paper → status example, no Zotero calls', async (t) => {
  const { req, zcalls } = await notesServer(t);
  const body = await (await req('GET', '/api/papers/exa/notes')).json();
  assert.equal(body.status, 'example');
  assert.equal(body.pending, 0);
  assert.equal(body.message, null);
  assert.equal(zcalls.info, 0);
});

test('POST highlights on example paper → 403', async (t) => {
  const { req } = await notesServer(t);
  const r = await req('POST', '/api/papers/exa/highlights', { sentenceIds: ['exa-s1'] });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, '예제 논문에는 메모를 저장하지 않습니다.');
  assert.equal((await req('PUT', '/api/papers/exa/card-memos/c1', { text: 'x' })).status, 403);
  assert.equal((await req('POST', '/api/papers/exa/note-conflict', { choice: 'overwrite' })).status, 403);
});

test('PUT/DELETE highlight, unknown hid → 404', async (t) => {
  const { req } = await notesServer(t);
  const h = await (await req('POST', '/api/papers/n1/highlights', { sentenceIds: ['n1-s1'] })).json();
  const up = await req('PUT', `/api/papers/n1/highlights/${h.id}`, { color: '#5fb236', comment: 'c' });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).comment, 'c');
  assert.equal((await req('PUT', `/api/papers/n1/highlights/${h.id}`, { color: 'red' })).status, 400);
  assert.equal((await req('PUT', '/api/papers/n1/highlights/h-nope', { comment: 'c' })).status, 404);
  assert.equal((await req('DELETE', '/api/papers/n1/highlights/h-nope')).status, 404);
  assert.equal((await req('DELETE', `/api/papers/n1/highlights/${h.id}`)).status, 204);
  assert.equal((await (await req('GET', '/api/papers/n1/notes')).json()).highlights.length, 0);
});

test('DELETE without allowed Host → 403', async (t) => {
  const { server } = await notesServer(t);
  const { default: http } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/papers/n1/highlights/h-x', method: 'DELETE', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject).end();
  });
  assert.equal(status, 403);
});

test('PUT card memo then GET notes shows it; empty deletes; too long 400', async (t) => {
  const { req } = await notesServer(t);
  assert.equal((await req('PUT', '/api/papers/n1/card-memos/c1', { text: '메모' })).status, 200);
  assert.deepEqual((await (await req('GET', '/api/papers/n1/notes')).json()).cardMemos, { c1: '메모' });
  assert.equal((await req('PUT', '/api/papers/n1/card-memos/c1', { text: '' })).status, 200);
  assert.deepEqual((await (await req('GET', '/api/papers/n1/notes')).json()).cardMemos, {});
  assert.equal((await req('PUT', '/api/papers/n1/card-memos/c1', { text: 'x'.repeat(5001) })).status, 400);
  assert.equal((await req('PUT', '/api/papers/n1/card-memos/c1', { text: 3 })).status, 400);
  assert.equal((await req('PUT', '/api/papers/n1/card-memos/bad%20id!', { text: 'x' })).status, 400);
});

test('note-conflict resolves; invalid choice 400', async (t) => {
  const { req } = await notesServer(t);
  const r = await req('POST', '/api/papers/n1/note-conflict', { choice: 'keep-zotero' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal((await req('POST', '/api/papers/n1/note-conflict', { choice: 'x' })).status, 400);
});

test('POST /api/zotero/authorize maps outcomes to 200 JSON', async (t) => {
  const a = await notesServer(t);
  assert.deepEqual(await (await a.req('POST', '/api/zotero/authorize', {})).json(), { ok: true, remember: true });
  const d = await notesServer(t, { authorizeError: 'denied' });
  const dr = await d.req('POST', '/api/zotero/authorize', {});
  assert.equal(dr.status, 200);
  assert.deepEqual(await dr.json(), { ok: false, status: 'denied' });
  const u = await notesServer(t, { authorizeError: 'weird' });
  assert.deepEqual(await (await u.req('POST', '/api/zotero/authorize', {})).json(), { ok: false, status: 'offline' });
});

test('paper endpoint and readPaper expose needsReextract', async (t) => {
  const { req } = await notesServer(t);
  assert.equal((await (await req('GET', '/api/papers/n1')).json()).needsReextract, true);
  const { readPaper } = await import('../src/reader/store.mjs');
  const ok = { ...nsource, sentences: { a: nsource.sentences['n1-s1'] } };
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-re-'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  await fs.mkdir(path.join(d, 'q'));
  await fs.writeFile(path.join(d, 'q', 'source.json'), JSON.stringify(ok));
  assert.equal((await readPaper(d, 'q', { examplesDir: null })).needsReextract, false);
  assert.equal((await readPaper(path.join(d, 'none'), 'n1', { examplesDir: null })), null);
});

test('authorize requires application/json (415 for text/plain, no dialog)', async (t) => {
  const { b, req, zcalls } = await notesServer(t);
  const bad = await fetch(`${b}/api/zotero/authorize`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(bad.status, 415);
  assert.equal(zcalls.authorize, 0);
  assert.equal((await req('POST', '/api/zotero/authorize', {})).status, 200);
  assert.equal(zcalls.authorize, 1);
});

test('card memo for unknown or special cardId → 404', async (t) => {
  const { req } = await notesServer(t);
  for (const c of ['__proto__', 'constructor', 'nope']) {
    const r = await req('PUT', `/api/papers/n1/card-memos/${c}`, { text: 'x' });
    assert.equal(r.status, 404, c);
    assert.equal((await r.json()).error, '요약 카드를 찾을 수 없습니다.');
  }
});

test('serves figure images from paper dir, then examples dir', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const png2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-fig-'));
  const ex = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-figex-'));
  try {
    for (const [root, id] of [[d, 'f1'], [ex, 'e1']]) {
      await fs.mkdir(path.join(root, id, 'figures'), { recursive: true });
      await fs.writeFile(path.join(root, id, 'source.json'), JSON.stringify({ id, meta: { title: id } }));
    }
    await fs.writeFile(path.join(d, 'f1', 'figures', 'fig-1-1.png'), png);
    await fs.writeFile(path.join(ex, 'e1', 'figures', 'fig-2-1.png'), png2);
    await fs.writeFile(path.join(d, 'secret.png'), png);
    await fs.symlink(path.join(d, 'secret.png'), path.join(d, 'f1', 'figures', 'fig-9-9.png'));
    // id collision: own dir has source.json but no figure; example has one -> must 404
    await fs.mkdir(path.join(d, 'e1'));
    await fs.writeFile(path.join(d, 'e1', 'source.json'), JSON.stringify({ id: 'e1', meta: { title: 'own' } }));
    // figures dir symlinked outside
    await fs.mkdir(path.join(d, 'f2'));
    await fs.writeFile(path.join(d, 'f2', 'source.json'), JSON.stringify({ id: 'f2', meta: { title: 'f2' } }));
    await fs.mkdir(path.join(d, 'outside'));
    await fs.writeFile(path.join(d, 'outside', 'fig-1-1.png'), png);
    await fs.symlink(path.join(d, 'outside'), path.join(d, 'f2', 'figures'));
    await fs.mkdir(path.join(ex, 'e2', 'figures'), { recursive: true });
    await fs.writeFile(path.join(ex, 'e2', 'source.json'), JSON.stringify({ id: 'e2', meta: { title: 'e2' } }));
    await fs.writeFile(path.join(ex, 'e2', 'figures', 'fig-2-1.png'), png2);
    const s = createServer({ outputDir: d, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { examplesDir: ex });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      const ok = await fetch(`${b}/api/papers/f1/figures/fig-1-1.png`);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'image/png');
      assert.equal(ok.headers.get('cache-control'), 'no-cache');
      assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(ok.headers.get('content-length'), String(png.length));
      assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
      const exr = await fetch(`${b}/api/papers/e2/figures/fig-2-1.png`);
      assert.equal(exr.status, 200);
      assert.deepEqual(Buffer.from(await exr.arrayBuffer()), png2);
      assert.equal((await fetch(`${b}/api/papers/e1/figures/fig-2-1.png`)).status, 404);
      assert.equal((await fetch(`${b}/api/papers/f2/figures/fig-1-1.png`)).status, 404);
      assert.equal((await fetch(`${b}/api/papers/f1/figures/..%2Fsource.json`)).status, 400);
      assert.equal((await fetch(`${b}/api/papers/f1/figures/fig-1-1.jpg`)).status, 400);
      assert.equal((await fetch(`${b}/api/papers/..%2Ff1/figures/fig-1-1.png`)).status, 400);
      const nf = await fetch(`${b}/api/papers/f1/figures/fig-5-5.png`);
      assert.equal(nf.status, 404);
      assert.equal((await nf.json()).error, '그림 파일을 찾을 수 없습니다.');
      assert.equal((await fetch(`${b}/api/papers/nope/figures/fig-1-1.png`)).status, 404);
      assert.equal((await fetch(`${b}/api/papers/f1/figures/fig-9-9.png`)).status, 404);
      assert.equal((await fetch(`${b}/api/papers/f1/figures/fig-1-1.png`, { method: 'POST' })).status, 404);
    } finally { s.close(); }
  } finally {
    await fs.rm(d, { recursive: true, force: true });
    await fs.rm(ex, { recursive: true, force: true });
  }
});

test('figure endpoint rejects bad Host', async () => {
  const res = await new Promise((resolve, reject) => {
    const u = new URL(`${base}/api/papers/p1/figures/fig-1-1.png`);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example' } }, resolve).on('error', reject);
  });
  assert.equal(res.statusCode, 403);
  res.resume();
});

// ---- PDF route ----
async function pdfServer(t, { deps = {}, papers }) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-pdf-'));
  const ex = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-pdf-ex-'));
  for (const [id, src] of Object.entries(papers(d))) {
    await fs.mkdir(path.join(d, id));
    await fs.writeFile(path.join(d, id, 'source.json'), JSON.stringify({ id, meta: { title: id }, pages: [], sentences: {}, ...src }));
  }
  await fs.mkdir(path.join(ex, 'exp'));
  await fs.writeFile(path.join(ex, 'exp', 'source.json'), JSON.stringify({ id: 'exp', pdf: { path: path.join(d, 'a.pdf'), md5: 'x' }, meta: {}, pages: [], sentences: {} }));
  const s = createServer({ outputDir: d, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { examplesDir: ex, ...deps });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(async () => { s.close(); await fs.rm(d, { recursive: true, force: true }); await fs.rm(ex, { recursive: true, force: true }); });
  return { dir: d, base: `http://127.0.0.1:${s.address().port}` };
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake\n');

test('pdf route serves the recorded file byte for byte', async (t) => {
  let dirRef;
  const { dir: d, base: b } = await pdfServer(t, { papers: (d) => { dirRef = d; return { a: { pdf: { path: path.join(d, 'a.pdf'), md5: 'x' } } }; } });
  await fs.writeFile(path.join(dirRef, 'a.pdf'), PDF_BYTES);
  const res = await fetch(`${b}/api/papers/a/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('content-length'), String(PDF_BYTES.length));
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF_BYTES);
  const body = await (await fetch(`${b}/api/papers/a`)).json();
  assert.equal(body.links.pdf, true);
  assert.ok(d);
});

test('pdf route rejects non-pdf extension, missing record, directories, bad host', async (t) => {
  let dirRef;
  const { base: b } = await pdfServer(t, {
    papers: (d) => { dirRef = d; return {
      txt: { pdf: { path: path.join(d, 'x.txt'), md5: 'x' } },
      none: {},
      gone: { pdf: { path: path.join(d, 'gone.pdf'), md5: 'x' } },
      dirp: { pdf: { path: path.join(d, 'dir.pdf'), md5: 'x' } },
      upper: { pdf: { path: path.join(d, 'U.PDF'), md5: 'x' } },
    }; },
  });
  await fs.writeFile(path.join(dirRef, 'x.txt'), PDF_BYTES);
  await fs.mkdir(path.join(dirRef, 'dir.pdf'));
  await fs.writeFile(path.join(dirRef, 'U.PDF'), PDF_BYTES);
  for (const id of ['txt', 'none', 'gone', 'dirp']) {
    const res = await fetch(`${b}/api/papers/${id}/pdf`);
    assert.equal(res.status, 404, id);
    assert.match((await res.json()).error, /PDF 파일을 찾을 수 없습니다/);
  }
  assert.equal((await fetch(`${b}/api/papers/upper/pdf`)).status, 200);
  assert.equal((await fetch(`${b}/api/papers/none`).then((r) => r.json())).links.pdf, false);
  const bad = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: new URL(b).port, path: '/api/papers/upper/pdf', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(bad, 403);
});

test('pdf route falls back to injected resolveItem via itemKey; Zotero errors give 404', async (t) => {
  let dirRef;
  const calls2 = [];
  const resolveItem = async (key) => {
    calls2.push(key);
    if (key === 'DOWN0001') throw new Error('Zotero가 실행 중이 아닙니다');
    return { pdfPath: path.join(dirRef, 'z.pdf') };
  };
  const { base: b } = await pdfServer(t, {
    deps: { resolveItem },
    papers: (d) => { dirRef = d; return {
      viaz: { zotero: { itemKey: 'ITEM0001', attachmentKey: 'A' } },
      stale: { zotero: { itemKey: 'ITEM0001' }, pdf: { path: path.join(d, 'moved.pdf'), md5: 'x' } },
      down: { zotero: { itemKey: 'DOWN0001' } },
    }; },
  });
  await fs.writeFile(path.join(dirRef, 'z.pdf'), PDF_BYTES);
  for (const id of ['viaz', 'stale']) {
    const res = await fetch(`${b}/api/papers/${id}/pdf`);
    assert.equal(res.status, 200, id);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF_BYTES);
  }
  assert.equal((await fetch(`${b}/api/papers/viaz`).then((r) => r.json())).links.pdf, true);
  assert.equal(calls2.length, 2);
  assert.equal((await fetch(`${b}/api/papers/down/pdf`)).status, 404);
});

test('example papers report links.pdf false and never serve a PDF', async (t) => {
  const { base: b } = await pdfServer(t, { papers: () => ({}) });
  assert.equal((await fetch(`${b}/api/papers/exp`).then((r) => r.json())).links.pdf, false);
  assert.equal((await fetch(`${b}/api/papers/exp/pdf`)).status, 404);
});

test('serves vendored pdf.js assets with correct MIME types', async () => {
  const mjs = await fetch(`${base}/vendor/pdfjs/pdf.min.mjs`);
  assert.equal(mjs.status, 200);
  assert.equal(mjs.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const worker = await fetch(`${base}/vendor/pdfjs/pdf.worker.min.mjs`);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const css = await fetch(`${base}/vendor/pdfjs/pdf_viewer.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const cmap = await fetch(`${base}/vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap`);
  assert.equal(cmap.status, 200);
  assert.equal(cmap.headers.get('content-type'), 'application/octet-stream');
  const pfb = await fetch(`${base}/vendor/pdfjs/standard_fonts/FoxitSerif.pfb`);
  assert.equal(pfb.status, 200);
  assert.equal(pfb.headers.get('content-type'), 'application/octet-stream');
  const ver = await fetch(`${base}/vendor/pdfjs/VERSION`);
  assert.equal(ver.status, 200);
  assert.equal((await ver.text()).trim(), '6.5.438');
  assert.equal((await fetch(`${base}/vendor/pdfjs/nope.bin`)).status, 404);
});


// ---- POST /api/library/extract ----
async function extractServer(t, deps = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-ext-')));
  const root = path.join(tmp, '논문 폴더');
  const dataDir = path.join(tmp, 'data');
  const out = path.join(tmp, 'out');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(out, { recursive: true });
  const pdfFile = path.join(root, 'one paper.pdf');
  await fs.writeFile(pdfFile, Buffer.from('%PDF-1.1\n% one\n%%EOF\n'));
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ folders: [root] }));
  const s = createServer({ outputDir: out, dataDir, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { examplesDir: path.join(tmp, 'none'), ...deps });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(async () => { s.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${s.address().port}`;
  const post = (body, headers = { 'content-type': 'application/json' }) => fetch(`${base}/api/library/extract`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const listed = async () => (await (await fetch(`${base}/api/papers`)).json()).papers.find((p) => p.state === 'pdf');
  return { post, listed, pdfFile, out, base };
}

test('extract route: 200 with injected extractor, then link step runs, source PDF untouched', async (t) => {
  const calls = [];
  const links = [];
  let ctx;
  const extractFile = async ({ cfg, file, id }) => {
    calls.push({ file, id, outputDir: cfg.outputDir });
    await fs.mkdir(path.join(cfg.outputDir, id), { recursive: true });
    await fs.writeFile(path.join(cfg.outputDir, id, 'source.json'), JSON.stringify({ id, meta: { title: 'T' }, pages: [], sentences: {} }));
    return { id, source: {} };
  };
  const linkToZotero = async (outputDir, id) => { links.push({ outputDir, id }); return false; };
  ctx = await extractServer(t, { extractFile, linkToZotero });
  const before = await fs.readFile(ctx.pdfFile);
  const paper = await ctx.listed();
  assert.ok(paper);
  assert.equal((await ctx.post({}, { 'content-type': 'text/plain' })).status, 415);
  const res = await ctx.post({ id: paper.id });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: paper.id, state: 'extracted' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, ctx.pdfFile);
  assert.equal(calls[0].id, paper.id);
  assert.deepEqual(links, [{ outputDir: ctx.out, id: paper.id }]);
  assert.deepEqual(await fs.readFile(ctx.pdfFile), before);
});

test('extract route: 404 for unknown id, 400 for bad body, default link step is a no-op', async (t) => {
  const extractFile = async ({ cfg, id }) => { await fs.mkdir(path.join(cfg.outputDir, id), { recursive: true }); return { id, source: {} }; };
  const { post, listed } = await extractServer(t, { extractFile });
  const miss = await post({ id: 'ghost-12345678' });
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).error, '폴더에서 이 PDF를 찾을 수 없습니다.');
  assert.equal((await post({ id: '../x' })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ id: (await listed()).id })).status, 200);
});

test('extract route: 409 while another extraction runs, 500 with the reason on failure, then free again', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const extractFile = async ({ id }) => {
    n += 1;
    if (n === 1) await gate;
    if (n === 2) throw new Error('텍스트를 추출할 수 없습니다(스캔 PDF로 보입니다).');
    return { id, source: {} };
  };
  const { post, listed } = await extractServer(t, { extractFile });
  const id = (await listed()).id;
  const first = post({ id });
  await new Promise((r) => setTimeout(r, 100));
  const busy = await post({ id });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, '다른 논문을 추출하고 있습니다. 끝난 뒤 다시 시도하세요.');
  release();
  assert.equal((await first).status, 200);
  const fail = await post({ id });
  assert.equal(fail.status, 500);
  assert.match((await fail.json()).error, /스캔 PDF/);
  assert.equal((await post({ id })).status, 200);
});

async function linkServer(t, deps) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-link-'));
  const out = path.join(tmp, 'out');
  for (const [id, zotero] of [['unl', undefined], ['lnk', { itemKey: 'ABCD1234', attachmentKey: 'ATT00001' }]]) {
    await fs.mkdir(path.join(out, id), { recursive: true });
    await fs.writeFile(path.join(out, id, 'source.json'), JSON.stringify({ id, ...(zotero ? { zotero } : {}), meta: { title: id }, pdf: { path: path.join(tmp, `${id}.pdf`), md5: 'm' }, pages: [], sentences: {} }));
  }
  const s = createServer({ outputDir: out, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { examplesDir: path.join(tmp, 'none'), ...deps });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(async () => { s.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  return `http://127.0.0.1:${s.address().port}`;
}

test('paper list retries linking unlinked papers in the background, once per cooldown, without blocking', async (t) => {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const base = await linkServer(t, { linkToZotero: async (o, id) => { calls.push(id); await gate; return true; } });
  const first = await fetch(`${base}/api/papers`); // must answer while the link attempt is still pending
  assert.equal(first.status, 200);
  await fetch(`${base}/api/papers`);
  assert.deepEqual(calls, ['unl']);
  release();
  await new Promise((r) => setTimeout(r, 20));
  await fetch(`${base}/api/papers`);
  assert.deepEqual(calls, ['unl']); // cooldown: no retry within 30 s
});

test('paper list: link failures are swallowed and retried after the cooldown', async (t) => {
  const calls = [];
  const base = await linkServer(t, { linkCooldownMs: 0, linkToZotero: async (o, id) => { calls.push(id); throw new Error('boom'); } });
  assert.equal((await fetch(`${base}/api/papers`)).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await fetch(`${base}/api/papers`)).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['unl', 'unl']);
});

const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('HUNG'), ms))]);

test('extract route: a hung Zotero in the link step times out quietly; the next extraction is not 409', async (t) => {
  let fetches = 0;
  const fetchImpl = () => { fetches += 1; return new Promise(() => {}); };
  const extractFile = async ({ cfg, file, id }) => {
    await fs.mkdir(path.join(cfg.outputDir, id), { recursive: true });
    await fs.writeFile(path.join(cfg.outputDir, id, 'source.json'), JSON.stringify({ id, meta: { title: 'T', doi: '10.1/x' }, pdf: { path: file, md5: 'm' }, pages: [], sentences: {} }));
    return { id, source: {} };
  };
  const { post, listed } = await extractServer(t, { extractFile, fetchImpl, zoteroTimeoutMs: 50, linkCooldownMs: 3_600_000 });
  const id = (await listed()).id;
  const first = await within(post({ id }), 3000);
  assert.notEqual(first, 'HUNG');
  assert.equal(first.status, 200);
  assert.ok(fetches >= 1);
  const second = await within(post({ id }), 3000);
  assert.notEqual(second, 'HUNG');
  assert.equal(second.status, 200);
});

test('paper list: a hung Zotero does not wedge background linking', async (t) => {
  let fetches = 0;
  const fetchImpl = () => { fetches += 1; return new Promise(() => {}); };
  const base = await linkServer(t, { fetchImpl, zoteroTimeoutMs: 50, linkCooldownMs: 0 });
  assert.equal((await fetch(`${base}/api/papers`)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fetches, 1);
  assert.equal((await fetch(`${base}/api/papers`)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fetches, 2);
});

test('agents API: list with selection, default first available, PUT validation and 415', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-agents-'));
  const dataDir = path.join(tmp, 'data');
  const detectAgents = async () => [
    { id: 'claude', name: 'Claude Code', available: true, version: '2.1.0' },
    { id: 'codex', name: 'Codex', available: false, message: '설치되어 있지 않습니다' },
  ];
  const home = path.join(tmp, 'home');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { SECRET: 'x' } }));
  const s = createServer({ outputDir: tmp, dataDir, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { detectAgents, home, env: {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(async () => { s.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  const b = `http://127.0.0.1:${s.address().port}`;
  const pj = (body, headers = { 'content-type': 'application/json' }) => fetch(`${b}/api/agents/selected`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const g = await (await fetch(`${b}/api/agents`)).json();
  assert.equal(g.agents.length, 2);
  assert.equal(g.selected, 'claude');
  assert.equal(g.agents[0].configuredModel, 'opus');
  assert.equal(g.agents[0].lastModel, null);
  assert.equal(g.agents[1].configuredModel, '기본값 (계정 플랜에 따라 정해짐)');
  assert.doesNotMatch(JSON.stringify(g), /SECRET/);
  assert.equal((await pj({ agent: 'claude' }, { 'content-type': 'text/plain' })).status, 415);
  const bad = await pj({ agent: 'codex' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, '이 AI 도구는 지금 쓸 수 없습니다.');
  assert.equal((await pj({ agent: 'gpt' })).status, 400);
  assert.equal((await pj({ agent: 'claude' })).status, 200);
  assert.equal((await (await fetch(`${b}/api/agents`)).json()).selected, 'claude');
  assert.equal((await fetch(`${b}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405);
  // folders PUT keeps the agent
  const f = await fetch(`${b}/api/library/folders`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [tmp] }) });
  assert.equal(f.status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).agent, 'claude');
  // a saved selection that became unavailable falls back to the first available tool
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ folders: [], agent: 'codex' }));
  assert.equal((await (await fetch(`${b}/api/agents`)).json()).selected, 'claude');
});

// ---- digest job API ----
async function digestServer(t, { runs = [], agents, extractFile, md5File, d1Pdf, home: homeDir } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-dj-')));
  const root = path.join(tmp, 'pdfs');
  const dataDir = path.join(tmp, 'data');
  const out = path.join(tmp, 'out');
  const examples = path.join(tmp, 'examples');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(out, 'd1'), { recursive: true });
  await fs.mkdir(path.join(examples, 'ex1'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.pdf'), Buffer.from('%PDF-1.1\n%%EOF\n'));
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ folders: [root] }));
  const src = { id: 'd1', meta: { title: 'D' }, pages: [{ page: 1 }], sentences: { 'p1-s1': { text: 'a', page: 1 } }, ...(d1Pdf ? { pdf: d1Pdf } : {}) };
  await fs.writeFile(path.join(out, 'd1', 'source.json'), JSON.stringify(src));
  await fs.writeFile(path.join(examples, 'ex1', 'source.json'), JSON.stringify({ ...src, id: 'ex1' }));
  const calls = [];
  const runAgent = ({ id, workdir, prompt, configDir }) => {
    let cancel;
    const cancelled = new Promise((r) => { cancel = () => r({ code: null, signal: 'SIGTERM', timedOut: false }); });
    calls.push({ id, workdir, prompt, configDir });
    const fn = runs[calls.length - 1] ?? (() => new Promise(() => {}));
    return { done: Promise.race([Promise.resolve().then(() => fn(workdir)), cancelled]), cancel: () => cancel() };
  };
  const detectAgents = async () => agents ?? [{ id: 'codex', name: 'Codex', available: true }, { id: 'claude', name: 'Claude Code', available: false }];
  const s = createServer({ outputDir: out, dataDir, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } },
    { examplesDir: examples, detectAgents, runAgent, extractFile, home: homeDir ?? path.join(tmp, 'home'), env: {}, ...(md5File ? { md5File } : {}) });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(async () => { s.close(); await s.digestJobs?.shutdown(); await fs.rm(tmp, { recursive: true, force: true }); });
  const b = `http://127.0.0.1:${s.address().port}`;
  const jpost = (p, body = {}, headers = { 'content-type': 'application/json' }) => fetch(b + p, { method: 'POST', headers, body: JSON.stringify(body) });
  const job = async (id) => (await fetch(`${b}/api/papers/${id}/digest-job`)).json();
  const settle = async (id) => {
    for (let i = 0; i < 400; i += 1) {
      const j = await job(id);
      if (['done', 'failed', 'cancelled'].includes(j.state)) return j;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('job did not settle');
  };
  return { s, b, out, root, jpost, job, settle, calls, dataDir };
}
const goodDigest = (id) => fullDigest({ paperId: id, evidence: 'p1-s1', cards: 12 });

test('digest API: 415 guard, 202 start with selected tool, GET job, done replaces digest', async (t) => {
  const ctx = await digestServer(t, { runs: [async (w) => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(goodDigest('d1'))); return { code: 0 }; }] });
  assert.equal((await fetch(`${ctx.b}/api/papers/d1/digest-job`)).status, 404);
  assert.equal((await ctx.jpost('/api/papers/d1/digest', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await ctx.jpost('/api/papers/d1/digest-job/cancel', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(ctx.calls.length, 0);
  const res = await ctx.jpost('/api/papers/d1/digest');
  assert.equal(res.status, 202);
  const j = await res.json();
  assert.equal(j.paperId, 'd1');
  assert.equal(j.agent, 'codex');
  assert.equal(j.maxAttempts, 3);
  const done = await ctx.settle('d1');
  assert.equal(done.state, 'done');
  assert.equal(ctx.calls[0].id, 'codex');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(ctx.out, 'd1', 'digest.json'), 'utf8')), goodDigest('d1'));
  assert.equal((await (await fetch(`${ctx.b}/api/papers/d1`)).json()).digest.takeaway.text, 't');
});

test('digest API: 409 while running, cancel 200, 404 unknown, 400 example, 400 bad id', async (t) => {
  const ctx = await digestServer(t);
  assert.equal((await ctx.jpost('/api/papers/d1/digest')).status, 202);
  const busy = await ctx.jpost('/api/papers/d1/digest');
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, '다른 논문의 요약을 만들고 있습니다.');
  for (let i = 0; i < 200 && !ctx.calls.length; i += 1) await new Promise((r) => setTimeout(r, 5));
  const c = await ctx.jpost('/api/papers/d1/digest-job/cancel');
  assert.equal(c.status, 200);
  assert.equal((await ctx.settle('d1')).state, 'cancelled');
  assert.equal((await ctx.jpost('/api/papers/d1/digest-job/cancel')).status, 404);
  const miss = await ctx.jpost('/api/papers/ghost/digest');
  assert.equal(miss.status, 404);
  const ex = await ctx.jpost('/api/papers/ex1/digest');
  assert.equal(ex.status, 400);
  assert.equal((await ex.json()).error, '예제 논문은 요약을 다시 만들 수 없습니다.');
  assert.equal((await ctx.jpost('/api/papers/..%2Fx/digest')).status, 400);
  assert.equal((await fetch(`${ctx.b}/api/papers/d1/digest`)).status, 404);
});

test('digest API: no available tool → 400 with install hint', async (t) => {
  const ctx = await digestServer(t, { agents: [{ id: 'claude', name: 'Claude Code', available: false }, { id: 'codex', name: 'Codex', available: false }] });
  const r = await ctx.jpost('/api/papers/d1/digest');
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, '쓸 수 있는 AI 도구가 없습니다. Claude Code, Codex, Gemini CLI 중 하나를 설치하고 로그인하세요.');
});

test('digest API: folder PDF is extracted first and shares the extraction busy flag', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const extractFile = async ({ cfg, id }) => {
    await gate;
    await fs.mkdir(path.join(cfg.outputDir, id), { recursive: true });
    await fs.writeFile(path.join(cfg.outputDir, id, 'source.json'), JSON.stringify({ id, meta: { title: 'P' }, pages: [{ page: 1 }], sentences: { 'p1-s1': { text: 'a', page: 1 } } }));
    return { id, source: {} };
  };
  let pdfId;
  const ctx = await digestServer(t, { extractFile, runs: [async (w) => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(goodDigest(pdfId))); return { code: 0 }; }] });
  pdfId = (await (await fetch(`${ctx.b}/api/papers`)).json()).papers.find((p) => p.state === 'pdf').id;
  const r = await ctx.jpost(`/api/papers/${encodeURIComponent(pdfId)}/digest`);
  assert.equal(r.status, 202);
  assert.equal((await r.json()).state, 'extracting');
  await new Promise((res) => setTimeout(res, 30));
  const manual = await ctx.jpost('/api/library/extract', { id: pdfId });
  assert.equal(manual.status, 409);
  release();
  const done = await ctx.settle(encodeURIComponent(pdfId));
  assert.equal(done.state, 'done', done.message);
  assert.equal(JSON.parse(await fs.readFile(path.join(ctx.out, pdfId, 'digest.json'), 'utf8')).paperId, pdfId);
});

// ---- duplicate PDFs (same MD5) ----
test('paper list shows one bundle per PDF md5 (digest > Zotero > oldest) and hides matching folder files', async (t) => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-dup-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'out');
  const root = path.join(tmp, 'pdfs');
  const dataDir = path.join(tmp, 'data');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(root, '2501.06706v1.pdf'), Buffer.from('%PDF-1.1\n%%EOF\n'));
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ folders: [root] }));
  const mk = async (id, { md5, zotero, digest, mtime }) => {
    await fs.mkdir(path.join(out, id), { recursive: true });
    const f = path.join(out, id, 'source.json');
    await fs.writeFile(f, JSON.stringify({ id, meta: { title: id }, pages: [], sentences: {}, pdf: { md5 }, ...(zotero ? { zotero: { itemKey: 'K', attachmentKey: 'A' } } : {}) }));
    if (digest) await fs.writeFile(path.join(out, id, 'digest.json'), JSON.stringify({ version: 1, paperId: id, cards: [] }));
    if (mtime) await fs.utimes(f, mtime, mtime);
  };
  await mk('a1', { md5: 'M1', zotero: true });
  await mk('a2', { md5: 'M1', digest: true });
  await mk('b2', { md5: 'M2', mtime: new Date('2024-01-01') });
  await mk('b1', { md5: 'M2', mtime: new Date('2020-01-01') });
  await mk('c1', { md5: 'M3', zotero: true });
  await mk('c2', { md5: 'M3' });
  await mk('solo', { md5: 'M4' });
  const s = createServer({ outputDir: out, dataDir, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } },
    { examplesDir: path.join(tmp, 'none'), md5File: async () => 'M1', linkCooldownMs: 3_600_000 });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => s.close());
  const list = async () => (await (await fetch(`http://127.0.0.1:${s.address().port}/api/papers`)).json());
  let body = await list();
  for (let i = 0; i < 200 && (body.hashing?.done ?? 0) < 1; i += 1) { await new Promise((r) => setTimeout(r, 5)); body = await list(); }
  assert.deepEqual(body.papers.map((p) => p.id).sort(), ['a2', 'b1', 'c1', 'solo']);
  assert.ok(!body.papers.some((p) => p.state === 'pdf'));
  for (const id of ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']) assert.ok((await fs.stat(path.join(out, id, 'source.json'))).isFile());
});

test('extract route: identical file (same md5, hashed now) is merged into the existing bundle, no new dir', async (t) => {
  let calls = 0;
  const extractFile = async () => { calls += 1; return {}; };
  let hashes = 0;
  const ctx = await extractServer(t, { extractFile, md5File: async () => { hashes += 1; return 'SAME'; } });
  await fs.mkdir(path.join(ctx.out, 'zot1'));
  await fs.writeFile(path.join(ctx.out, 'zot1', 'source.json'), JSON.stringify({ id: 'zot1', pages: [], sentences: {}, pdf: { md5: 'SAME', path: '/elsewhere/a.pdf' }, zotero: { itemKey: 'K' } }));
  const root = path.dirname(ctx.pdfFile);
  const id = folderPaperId(root, 'one paper.pdf', 'one paper.pdf');
  const res = await ctx.post({ id });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'zot1', state: 'extracted', merged: true });
  assert.equal(calls, 0);
  assert.ok(hashes >= 1);
  assert.deepEqual(await fs.readdir(ctx.out), ['zot1']);
});

test('extract route: same realpath (NFD-stored path) is merged even with a different md5; different file extracts', async (t) => {
  let calls = 0;
  const extractFile = async ({ cfg, id }) => { calls += 1; await fs.mkdir(path.join(cfg.outputDir, id), { recursive: true }); return {}; };
  const ctx = await extractServer(t, { extractFile, md5File: async () => 'NEW' });
  const id = folderPaperId(path.dirname(ctx.pdfFile), 'one paper.pdf', 'one paper.pdf');
  await fs.mkdir(path.join(ctx.out, 'old1'));
  await fs.writeFile(path.join(ctx.out, 'old1', 'source.json'), JSON.stringify({ id: 'old1', pages: [], sentences: {}, pdf: { md5: 'OLD', path: ctx.pdfFile.normalize('NFD') } }));
  await fs.writeFile(path.join(ctx.out, 'old1', 'digest.json'), '{}');
  assert.deepEqual(await (await ctx.post({ id })).json(), { id: 'old1', state: 'digest', merged: true });
  assert.equal(calls, 0);
  await fs.rm(path.join(ctx.out, 'old1'), { recursive: true });
  assert.equal((await ctx.post({ id })).status, 200);
  assert.equal(calls, 1);
});

test('digest API: folder PDF identical to an existing paper runs on that paper, no extraction', async (t) => {
  let extracted = 0;
  const ctx = await digestServer(t, {
    md5File: async () => 'DUP',
    d1Pdf: { md5: 'DUP' },
    extractFile: async () => { extracted += 1; return {}; },
    runs: [async (w) => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(goodDigest('d1'))); return { code: 0 }; }],
  });
  const id = folderPaperId(ctx.root, 'a.pdf', 'a.pdf');
  const r = await ctx.jpost(`/api/papers/${id}/digest`);
  assert.equal(r.status, 202);
  const done = await ctx.settle(id);
  assert.equal(done.state, 'done', done.message);
  assert.equal(done.paperId, 'd1');
  assert.equal(extracted, 0);
  assert.equal((await ctx.job('d1')).state, 'done');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(ctx.out, 'd1', 'digest.json'), 'utf8')), goodDigest('d1'));
  assert.deepEqual((await fs.readdir(ctx.out)).sort(), ['d1']);
});

test('agents API: the model a digest run reported shows as lastModel', async (t) => {
  const ctx = await digestServer(t, { runs: [async (w) => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(goodDigest('d1'))); return { code: 0, model: 'gpt-5-codex' }; }] });
  assert.equal((await ctx.jpost('/api/papers/d1/digest')).status, 202);
  assert.equal((await ctx.settle('d1')).state, 'done');
  const g = await (await fetch(`${ctx.b}/api/agents`)).json();
  const codex = g.agents.find((a) => a.id === 'codex');
  assert.equal(codex.lastModel.model, 'gpt-5-codex');
  assert.ok(!Number.isNaN(Date.parse(codex.lastModel.at)));
  assert.equal(g.agents.find((a) => a.id === 'claude').lastModel, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(ctx.dataDir, 'settings.json'), 'utf8')).lastModels.codex.model, 'gpt-5-codex');
});

test('agents API: Claude accounts (aliases) with email and model, chosen account drives the run env; no paths sent', async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-home-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const yvin = path.join(home, '.claude', 'yvin');
  await fs.mkdir(yvin, { recursive: true });
  await fs.writeFile(path.join(home, '.zshrc'), "alias claude-yvin='CLAUDE_CONFIG_DIR=~/.claude/yvin claude'\n");
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }));
  await fs.writeFile(path.join(yvin, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'yvin@x.com' } }));
  await fs.writeFile(path.join(yvin, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
  const ctx = await digestServer(t, {
    home,
    agents: [{ id: 'claude', name: 'Claude Code', available: true }, { id: 'codex', name: 'Codex', available: false }],
    runs: [async (w) => { await fs.writeFile(path.join(w, 'digest.json'), JSON.stringify(goodDigest('d1'))); return { code: 0, model: 'claude-sonnet-4-5' }; }],
  });
  const pj = (body) => fetch(`${ctx.b}/api/agents/selected`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let g = await (await fetch(`${ctx.b}/api/agents`)).json();
  const claude = () => g.agents.find((a) => a.id === 'claude');
  assert.equal(claude().selectedProfile, 'claude');
  assert.deepEqual(claude().profiles.map((p) => [p.label, p.email]), [['claude', 'me@x.com'], ['claude-yvin', 'yvin@x.com']]);
  assert.ok(!JSON.stringify(g).includes(home), 'no local paths in the response');
  assert.equal((await pj({ agent: 'claude', profile: 'nope' })).status, 400);
  assert.equal((await pj({ agent: 'codex', profile: 'claude' })).status, 400);
  const r = await pj({ agent: 'claude', profile: 'claude-yvin' });
  assert.equal(r.status, 200);
  g = await r.json();
  assert.equal(claude().selectedProfile, 'claude-yvin');
  assert.equal(claude().configuredModel, 'sonnet');
  assert.equal((await ctx.jpost('/api/papers/d1/digest')).status, 202);
  assert.equal((await ctx.settle('d1')).state, 'done');
  assert.equal(ctx.calls[0].configDir, yvin);
  g = await (await fetch(`${ctx.b}/api/agents`)).json();
  assert.equal(claude().lastModel.model, 'claude-sonnet-4-5');
  assert.equal(claude().profiles.find((p) => p.label === 'claude').lastModel, null);
  // switching back to the default account: the run gets no config dir (CLAUDE_CONFIG_DIR removed)
  assert.equal((await pj({ agent: 'claude', profile: 'claude' })).status, 200);
});
