import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveItem, fileUrlToLocalPath } from '../src/zotero/local.mjs';

const cfg = { zotero: { baseUrl: 'http://127.0.0.1:23119' } };
const json = (data, status = 200) => ({ status, ok: status < 300, json: async () => data, text: async () => JSON.stringify(data) });
const text = (t, status = 200) => ({ status, ok: status < 300, json: async () => ({}), text: async () => t });

const item = {
  key: 'H9RA4VSE',
  data: {
    itemType: 'journalArticle', title: 'A Title', citationKey: 'chen2025x', DOI: '10.1/x',
    creators: [{ firstName: 'Yun', lastName: 'Chen' }, { name: 'Plato' }],
    publicationTitle: 'Journal X', date: '2025-03-01',
  },
};
const children = [
  { key: 'NOTEKEY1', data: { itemType: 'note' } },
  { key: 'IG8JQQUI', data: { itemType: 'attachment', contentType: 'application/pdf', linkMode: 'linked_file' } },
];

function fake(routes, calls = []) {
  return async (u) => {
    calls.push(u);
    for (const [frag, r] of routes) if (u.includes(frag)) return typeof r === 'function' ? r() : r;
    return json({}, 404);
  };
}

test('decodes NFD Korean + spaces file URL exactly', () => {
  const p = fileUrlToLocalPath('file:///Users/x/%E1%84%82%E1%85%A2%20%E1%84%83%E1%85%B3/Chen%20%EB%93%B1%20-%202025.pdf');
  assert.equal(p, `/Users/x/${'내 드'.normalize('NFD')}/Chen 등 - 2025.pdf`);
  assert.notEqual(p, p.normalize('NFC'));
});

test('resolves citekey to item and first PDF attachment', async () => {
  const calls = [];
  const fetchImpl = fake([
    ['/items?q=', json([{ key: 'ZZZZZZZZ', data: { citationKey: 'other' } }, item])],
    ['/IG8JQQUI/file/view/url', text('file:///tmp/a%20b/p.pdf')],
    ['/H9RA4VSE/children', json(children)],
  ], calls);
  const r = await resolveItem('chen2025x', cfg, { fetchImpl });
  assert.equal(r.id, 'chen2025x');
  assert.equal(r.itemKey, 'H9RA4VSE');
  assert.equal(r.attachmentKey, 'IG8JQQUI');
  assert.equal(r.pdfPath, '/tmp/a b/p.pdf');
  assert.deepEqual(r.meta, { title: 'A Title', authors: ['Yun Chen', 'Plato'], journal: 'Journal X', date: '2025-03-01', doi: '10.1/x' });
  assert.match(calls[0], /\/api\/users\/0\/items\?q=chen2025x&qmode=everything&format=json/);
});

test('8-char key path skips search', async () => {
  const calls = [];
  const fetchImpl = fake([
    ['/IG8JQQUI/file/view/url', text('file:///tmp/p.pdf')],
    ['/H9RA4VSE/children', json(children)],
    ['/items/H9RA4VSE?', json(item)],
  ], calls);
  const r = await resolveItem('H9RA4VSE', cfg, { fetchImpl });
  assert.equal(r.id, 'chen2025x');
  assert.ok(!calls.some((u) => u.includes('?q=')));
});

test('no citationKey falls back to item key; empty DOI stays ""', async () => {
  const bare = { key: 'H9RA4VSE', data: { ...item.data, citationKey: '', DOI: '' } };
  const fetchImpl = fake([
    ['/IG8JQQUI/file/view/url', text('file:///tmp/p.pdf')],
    ['/children', json(children)],
    ['/items/H9RA4VSE?', json(bare)],
  ]);
  const r = await resolveItem('H9RA4VSE', cfg, { fetchImpl });
  assert.equal(r.id, 'H9RA4VSE');
  assert.equal(r.meta.doi, '');
});

test('no PDF attachment gives Korean guidance', async () => {
  const fetchImpl = fake([['/children', json([{ key: 'N', data: { itemType: 'note' } }])], ['/items/H9RA4VSE?', json(item)]]);
  await assert.rejects(resolveItem('H9RA4VSE', cfg, { fetchImpl }),
    { message: '이 항목에 PDF 첨부가 없습니다. PDF를 Zotero에 넣은 뒤 다시 실행하세요.' });
});

test('unknown item and unknown citekey give not-found message', async () => {
  await assert.rejects(resolveItem('H9RA4VSE', cfg, { fetchImpl: fake([]) }),
    { message: "Zotero에서 'H9RA4VSE' 항목을 찾지 못했습니다." });
  await assert.rejects(resolveItem('nokey', cfg, { fetchImpl: fake([['/items?q=', json([])]]) }),
    { message: "Zotero에서 'nokey' 항목을 찾지 못했습니다." });
});

test('connection refused gives not-running message', async () => {
  await assert.rejects(resolveItem('H9RA4VSE', cfg, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    { message: /^Zotero가 실행 중이 아닙니다/ });
});

test('DOI input searches by DOI and matches data.DOI case-insensitively', async () => {
  const calls = [];
  const doiItem = { key: 'H9RA4VSE', data: { ...item.data, DOI: '10.1016/J.Ab.2025.1' } };
  const fetchImpl = fake([
    ['/items?q=', json([{ key: 'ZZZZZZZZ', data: { DOI: '10.1016/other' } }, doiItem])],
    ['/IG8JQQUI/file/view/url', text('file:///tmp/p.pdf')],
    ['/H9RA4VSE/children', json(children)],
  ], calls);
  const r = await resolveItem('10.1016/j.ab.2025.1', cfg, { fetchImpl });
  assert.equal(r.itemKey, 'H9RA4VSE');
  assert.equal(r.id, 'chen2025x');
  assert.match(calls[0], /items\?q=10\.1016%2Fj\.ab\.2025\.1&qmode=everything&format=json/);
  await assert.rejects(resolveItem('10.9/none', cfg, { fetchImpl: fake([['/items?q=', json([doiItem])]]) }),
    { message: "Zotero에서 '10.9/none' 항목을 찾지 못했습니다." });
});
