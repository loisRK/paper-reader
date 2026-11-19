import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoteroRunning, registerPaper, splitCreator, NOT_RUNNING_MESSAGE } from '../src/zotero/local.mjs';

const cfg = { zotero: { baseUrl: 'http://127.0.0.1:23119' } };
const paper = {
  n: 1, doi: '10.1000/abc', title: 'A Title', authors: ['Yun-Song Zhou', 'Plato'],
  journal: 'Journal X', issn: ['1111-2222', '3333-4444'], publicationDate: '2025-03-01',
  oaPdfUrl: 'https://example.org/a.pdf',
};
const res = (status) => ({ status, ok: status >= 200 && status < 300, text: async () => '' });

test('splitCreator', () => {
  assert.deepEqual(splitCreator('Yun-Song Zhou'), { firstName: 'Yun-Song', lastName: 'Zhou', creatorType: 'author' });
  assert.deepEqual(splitCreator('Plato'), { lastName: 'Plato', firstName: '', creatorType: 'author' });
  assert.deepEqual(splitCreator('Ludwig van Beethoven'), { firstName: 'Ludwig van', lastName: 'Beethoven', creatorType: 'author' });
});

test('zoteroRunning: ping 200 / non-200 / throws', async () => {
  const calls = [];
  assert.equal(await zoteroRunning(cfg, { fetchImpl: async (u) => (calls.push(u), res(200)) }), true);
  assert.equal(calls[0], 'http://127.0.0.1:23119/connector/ping');
  assert.equal(await zoteroRunning(cfg, { fetchImpl: async () => res(500) }), false);
  assert.equal(await zoteroRunning(cfg, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
});

test('registerPaper posts connector body with PDF attachment', async () => {
  const calls = [];
  const r = await registerPaper(paper, cfg, { fetchImpl: async (u, init) => (calls.push({ u, init }), res(201)) });
  assert.equal(r.ok, true);
  assert.equal(r.pdfAttached, true);
  assert.equal(calls[0].u, 'http://127.0.0.1:23119/connector/saveItems');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.sessionID, /^[0-9a-f-]{36}$/);
  assert.equal(body.uri, 'https://doi.org/10.1000/abc');
  assert.deepEqual(body.items[0], {
    itemType: 'journalArticle', title: 'A Title',
    creators: [
      { firstName: 'Yun-Song', lastName: 'Zhou', creatorType: 'author' },
      { lastName: 'Plato', firstName: '', creatorType: 'author' },
    ],
    publicationTitle: 'Journal X', date: '2025-03-01', DOI: '10.1000/abc', ISSN: '1111-2222, 3333-4444',
    url: 'https://doi.org/10.1000/abc',
    attachments: [{ title: 'Full Text PDF', url: 'https://example.org/a.pdf', mimeType: 'application/pdf' }],
  });
});

test('registerPaper without OA PDF', async () => {
  const r = await registerPaper({ ...paper, oaPdfUrl: null }, cfg, { fetchImpl: async () => res(201) });
  assert.equal(r.ok, true);
  assert.equal(r.pdfAttached, false);
  assert.equal(r.message, 'PDF 없음: 기관 구독으로 PDF를 받아 Zotero 항목에 넣어주세요.');
  let body;
  await registerPaper({ ...paper, oaPdfUrl: null }, cfg, { fetchImpl: async (u, i) => (body = JSON.parse(i.body), res(201)) });
  assert.deepEqual(body.items[0].attachments, []);
});

test('registerPaper: not running and non-201', async () => {
  const off = await registerPaper(paper, cfg, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(off.ok, false);
  assert.equal(off.message, NOT_RUNNING_MESSAGE);
  assert.equal(NOT_RUNNING_MESSAGE, 'Zotero가 실행 중이 아닙니다. Zotero를 켠 뒤 다시 실행하세요.');
  const bad = await registerPaper(paper, cfg, { fetchImpl: async () => res(400) });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /400/);
});
