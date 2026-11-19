import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findZoteroAttachment, linkToZotero } from '../src/zotero/link.mjs';

const cfg = { zotero: { baseUrl: 'http://z.test' } };

async function tmpdir(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'zlink-'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return await fs.realpath(d);
}

const json = (body, headers = {}) => ({
  ok: true, status: 200,
  headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
  json: async () => body, text: async () => JSON.stringify(body),
});
const text = (s) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => s, json: async () => s });

// fake Zotero. atts: [{key, path, parent, file}] ; items: {KEY: data}
function fakeZotero({ atts = [], items = {}, version = 7 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const p = u.pathname.replace('/api/users/0/', '');
    if (p === 'items' && u.searchParams.get('itemType') === 'attachment') {
      const start = Number(u.searchParams.get('start') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const page = atts.slice(start, start + limit).map((a) => ({
        key: a.key,
        data: { key: a.key, itemType: 'attachment', linkMode: 'linked_file', contentType: 'application/pdf', path: a.path, md5: null, parentItem: a.parent },
      }));
      return json(page, { 'Total-Results': String(atts.length), 'Last-Modified-Version': String(version) });
    }
    if (p === 'items' && u.searchParams.get('q')) {
      const q = u.searchParams.get('q').toLowerCase();
      return json(Object.entries(items).filter(([, d]) => String(d.DOI ?? '').toLowerCase() === q).map(([key, data]) => ({ key, data })));
    }
    let m = p.match(/^items\/([A-Z0-9]{8})\/children$/);
    if (m) {
      return json(atts.filter((a) => a.parent === m[1]).map((a) => ({ key: a.key, data: { key: a.key, contentType: 'application/pdf', linkMode: 'linked_file', path: a.path, parentItem: a.parent } })));
    }
    m = p.match(/^items\/([A-Z0-9]{8})\/file\/view\/url$/);
    if (m) {
      const a = atts.find((x) => x.key === m[1]);
      return a ? text(pathToFileURL(a.file).href) : { ok: false, status: 404, headers: { get: () => null } };
    }
    m = p.match(/^items\/([A-Z0-9]{8})$/);
    if (m && items[m[1]]) return json({ key: m[1], data: items[m[1]] });
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  return { fetchImpl, calls };
}

const PARENT = { ABCD1234: { title: 'Zotero Title', creators: [{ firstName: 'A', lastName: 'B' }], publicationTitle: 'J', date: '2024', DOI: '10.1/x' } };

test('same file name and same realpath -> linked, meta from parent', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'paper one.pdf');
  await fs.writeFile(pdf, 'a');
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: 'attachments:paper one.pdf', parent: 'ABCD1234', file: pdf }], items: PARENT });
  const r = await findZoteroAttachment({ file: pdf, md5: 'x', doi: '' }, cfg, { fetchImpl: z.fetchImpl, cache: {} });
  assert.equal(r.itemKey, 'ABCD1234');
  assert.equal(r.attachmentKey, 'ATT00001');
  assert.equal(r.meta.title, 'Zotero Title');
  assert.deepEqual(r.meta.authors, ['A B']);
});

test('storage: prefix is understood', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'p.pdf');
  await fs.writeFile(pdf, 'a');
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: 'storage:p.pdf', parent: 'ABCD1234', file: pdf }], items: PARENT });
  const r = await findZoteroAttachment({ file: pdf, md5: 'x' }, cfg, { fetchImpl: z.fetchImpl, cache: {} });
  assert.equal(r?.attachmentKey, 'ATT00001');
});

test('same name but different path -> not linked', async (t) => {
  const d = await tmpdir(t);
  await fs.mkdir(path.join(d, 'a'));
  await fs.mkdir(path.join(d, 'b'));
  const mine = path.join(d, 'a', 'p.pdf');
  const theirs = path.join(d, 'b', 'p.pdf');
  await fs.writeFile(mine, 'a');
  await fs.writeFile(theirs, 'a');
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: 'attachments:p.pdf', parent: 'ABCD1234', file: theirs }], items: PARENT });
  assert.equal(await findZoteroAttachment({ file: mine, md5: 'x', doi: '' }, cfg, { fetchImpl: z.fetchImpl, cache: {} }), null);
});

test('symlinked path resolves to same realpath -> linked', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'p.pdf');
  await fs.writeFile(pdf, 'a');
  await fs.symlink(d, path.join(d, 'lnk'));
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: 'attachments:p.pdf', parent: 'ABCD1234', file: path.join(d, 'lnk', 'p.pdf') }], items: PARENT });
  assert.ok(await findZoteroAttachment({ file: pdf }, cfg, { fetchImpl: z.fetchImpl, cache: {} }));
});

test('NFD file name in Zotero matches NFC file name on disk', async (t) => {
  const d = await tmpdir(t);
  const nfc = '논문.pdf'.normalize('NFC');
  const pdf = path.join(d, nfc);
  await fs.writeFile(pdf, 'a');
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: `attachments:${nfc.normalize('NFD')}`, parent: 'ABCD1234', file: pdf }], items: PARENT });
  assert.ok(await findZoteroAttachment({ file: pdf }, cfg, { fetchImpl: z.fetchImpl, cache: {} }));
});

test('different name, same DOI, same MD5 -> linked', async (t) => {
  const d = await tmpdir(t);
  const mine = path.join(d, 'renamed.pdf');
  const theirs = path.join(d, 'orig.pdf');
  await fs.writeFile(mine, 'same');
  await fs.writeFile(theirs, 'same');
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: 'attachments:orig.pdf', parent: 'ABCD1234', file: theirs }], items: PARENT });
  const md5File = async () => 'MD5';
  const r = await findZoteroAttachment({ file: mine, md5: 'MD5', doi: '10.1/X' }, cfg, { fetchImpl: z.fetchImpl, md5File, cache: {} });
  assert.equal(r?.itemKey, 'ABCD1234');
});

test('same DOI but different MD5 -> not linked', async (t) => {
  const d = await tmpdir(t);
  const mine = path.join(d, 'renamed.pdf');
  const theirs = path.join(d, 'orig.pdf');
  await fs.writeFile(mine, 'a');
  await fs.writeFile(theirs, 'b');
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: 'attachments:orig.pdf', parent: 'ABCD1234', file: theirs }], items: PARENT });
  const r = await findZoteroAttachment({ file: mine, md5: 'MINE', doi: '10.1/x' }, cfg, { fetchImpl: z.fetchImpl, md5File: async () => 'OTHER', cache: {} });
  assert.equal(r, null);
});

test('Zotero off (fetch throws) -> null, no exception', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'p.pdf');
  await fs.writeFile(pdf, 'a');
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await findZoteroAttachment({ file: pdf, md5: 'x', doi: '10.1/x' }, cfg, { fetchImpl, cache: {} }), null);
});

test('same library version -> attachment pages are not re-fetched', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'p.pdf');
  await fs.writeFile(pdf, 'a');
  const atts = Array.from({ length: 150 }, (_, i) => ({ key: `ATT${String(i).padStart(5, '0')}`, path: `attachments:f${i}.pdf`, parent: 'ABCD1234', file: path.join(d, `f${i}.pdf`) }));
  atts.push({ key: 'ATTMINE1', path: 'attachments:p.pdf', parent: 'ABCD1234', file: pdf });
  const z = fakeZotero({ atts, items: PARENT, version: 9 });
  const cache = {};
  const deps = { fetchImpl: z.fetchImpl, cache };
  assert.equal((await findZoteroAttachment({ file: pdf }, cfg, deps)).attachmentKey, 'ATTMINE1');
  const lists = () => z.calls.filter((u) => u.includes('itemType=attachment'));
  assert.equal(lists().length, 2); // 151 attachments -> two pages
  assert.ok(lists()[1].includes('start=100'));
  assert.ok(await findZoteroAttachment({ file: pdf }, cfg, deps));
  assert.equal(lists().length, 3); // only page 1 (version probe), no start=100 again
  assert.equal(lists().filter((u) => u.includes('start=100')).length, 1);
});

test('changed library version -> index rebuilt', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'p.pdf');
  await fs.writeFile(pdf, 'a');
  const atts = [];
  let version = 1;
  const base = fakeZotero({ atts, items: PARENT });
  const fetchImpl = async (url) => {
    const r = await base.fetchImpl(url);
    if (url.includes('itemType=attachment')) {
      return { ...r, headers: { get: (k) => (k.toLowerCase() === 'last-modified-version' ? String(version) : r.headers.get(k)) } };
    }
    return r;
  };
  const deps = { fetchImpl, cache: {} };
  assert.equal(await findZoteroAttachment({ file: pdf }, cfg, deps), null);
  atts.push({ key: 'ATT00001', path: 'attachments:p.pdf', parent: 'ABCD1234', file: pdf });
  version = 2;
  assert.ok(await findZoteroAttachment({ file: pdf }, cfg, deps));
});

test('linkToZotero writes zotero + meta to source.json atomically, leaves other files alone', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'p.pdf');
  await fs.writeFile(pdf, 'a');
  const out = path.join(d, 'out');
  await fs.mkdir(path.join(out, 'pid', 'figures'), { recursive: true });
  await fs.writeFile(path.join(out, 'pid', 'digest.json'), '{"x":1}');
  await fs.writeFile(path.join(out, 'pid', 'figures', 'a.png'), 'png');
  const src = { extractorVersion: 4, pymupdfVersion: '1', id: 'pid', meta: { title: 'file', authors: [], journal: '', date: '', doi: '' }, pdf: { path: pdf, md5: 'm' }, pages: [] };
  await fs.writeFile(path.join(out, 'pid', 'source.json'), JSON.stringify(src));
  const z = fakeZotero({ atts: [{ key: 'ATT00001', path: 'attachments:p.pdf', parent: 'ABCD1234', file: pdf }], items: PARENT });
  const deps = { fetchImpl: z.fetchImpl, cache: {} };
  assert.equal(await linkToZotero(out, 'pid', cfg, deps), true);
  const after = JSON.parse(await fs.readFile(path.join(out, 'pid', 'source.json'), 'utf8'));
  assert.deepEqual(after.zotero, { itemKey: 'ABCD1234', attachmentKey: 'ATT00001' });
  assert.equal(after.meta.title, 'Zotero Title');
  assert.deepEqual(after.pdf, src.pdf);
  assert.equal(await fs.readFile(path.join(out, 'pid', 'digest.json'), 'utf8'), '{"x":1}');
  assert.deepEqual((await fs.readdir(path.join(out, 'pid'))).sort(), ['digest.json', 'figures', 'source.json']);
  // already linked -> true, no further requests
  const n = z.calls.length;
  assert.equal(await linkToZotero(out, 'pid', cfg, deps), true);
  assert.equal(z.calls.length, n);
});

test('linkToZotero returns false when nothing matches or Zotero is off, source untouched', async (t) => {
  const d = await tmpdir(t);
  const pdf = path.join(d, 'p.pdf');
  await fs.writeFile(pdf, 'a');
  const out = path.join(d, 'out');
  await fs.mkdir(path.join(out, 'pid'), { recursive: true });
  const raw = JSON.stringify({ id: 'pid', meta: { doi: '' }, pdf: { path: pdf, md5: 'm' } });
  await fs.writeFile(path.join(out, 'pid', 'source.json'), raw);
  const off = async () => { throw new Error('down'); };
  assert.equal(await linkToZotero(out, 'pid', cfg, { fetchImpl: off, cache: {} }), false);
  assert.equal(await linkToZotero(out, 'nope', cfg, { fetchImpl: off, cache: {} }), false);
  assert.equal(await fs.readFile(path.join(out, 'pid', 'source.json'), 'utf8'), raw);
});

test('hung Zotero (fetch never resolves) -> null within the injected timeout', async (t) => {
  const d = await tmpdir(t);
  const file = path.join(d, 'x.pdf');
  await fs.writeFile(file, 'x');
  let n = 0;
  const fetchImpl = () => { n += 1; return new Promise(() => {}); };
  const started = Date.now();
  const r = await Promise.race([
    findZoteroAttachment({ file, md5: 'm', doi: '10.1/x' }, cfg, { fetchImpl, cache: new Map(), timeoutMs: 50 }),
    new Promise((res) => setTimeout(() => res('HUNG'), 2000)),
  ]);
  assert.equal(r, null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(n, 1);
});

test('every link request carries an abort signal', async (t) => {
  const d = await tmpdir(t);
  const file = path.join(d, 'x.pdf');
  await fs.writeFile(file, 'x');
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init?.signal instanceof AbortSignal); throw new Error('off'); };
  assert.equal(await findZoteroAttachment({ file }, cfg, { fetchImpl, cache: new Map() }), null);
  assert.deepEqual(seen, [true]);
});
