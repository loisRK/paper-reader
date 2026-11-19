import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/reader/server.mjs';

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
  const list = await (await fetch(`${base}/api/papers`)).json();
  const p1 = list.find((p) => p.id === 'p1');
  assert.deepEqual(p1, { id: 'p1', title: 'T1', journal: 'J1', date: '2025-01-01', hasDigest: true, cardsRead: 1, cardsTotal: 2 });
  const p2 = list.find((p) => p.id === 'p2');
  assert.equal(p2.cardsTotal, 0);
  assert.ok(!list.some((p) => p.id === '_search'));
});

test('paper endpoint returns validated digest and problems', async () => {
  const body = await (await fetch(`${base}/api/papers/p1`)).json();
  assert.equal(body.problems.length, 1);
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
  assert.deepEqual(body.links, { zoteroPdf: null, zoteroItem: null });
});
