import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSettings, writeSettings } from '../src/library/settings.mjs';
import { scanFolders, folderPaperId } from '../src/library/scan.mjs';
import { isSafeName } from '../src/reader/store.mjs';
import { createServer } from '../src/reader/server.mjs';

const pdf = (tag) => Buffer.from(`%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\n% ${tag}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);

let tmp, root, dataDir, outDir;
before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-lib-')));
  root = path.join(tmp, '논문 모음');
  dataDir = path.join(tmp, 'data');
  outDir = path.join(tmp, 'out');
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.mkdir(path.join(root, 'b'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'elsewhere'), { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(root, 'a', 'same.pdf'), pdf('one'));
  await fs.writeFile(path.join(root, 'b', 'same.pdf'), pdf('two'));
  await fs.writeFile(path.join(root, '한글 이름 논문.PDF'), pdf('korean'));
  await fs.writeFile(path.join(root, 'notes.txt'), 'x');
  await fs.writeFile(path.join(root, '.hidden', 'h.pdf'), pdf('hidden'));
  await fs.writeFile(path.join(tmp, 'elsewhere', 'linked.pdf'), pdf('linked'));
  await fs.symlink(path.join(tmp, 'elsewhere'), path.join(root, 'link'));
});
after(() => fs.rm(tmp, { recursive: true, force: true }));

test('scan: recursion, hidden and symlink dirs skipped, ids unique and safe', async () => {
  const { files, problems } = await scanFolders([root], { dataDir });
  assert.deepEqual(problems, []);
  assert.deepEqual(files.map((f) => f.rel).sort(), ['a/same.pdf', 'b/same.pdf', '한글 이름 논문.PDF'].sort());
  const ids = files.map((f) => f.id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.ok(isSafeName(id), id);
  const ko = files.find((f) => f.rel.startsWith('한글'));
  assert.ok(ko.id.startsWith('한글_이름_논문-'));
  assert.equal(ko.root, root);
  assert.match(ko.md5, /^[0-9a-f]{32}$/);
});

test('folderPaperId: empty name falls back to paper, capped at 60 chars', () => {
  assert.match(folderPaperId('/r', '!!!.pdf', '!!!.pdf'), /^paper-[0-9a-f]{8}$/);
  const long = folderPaperId('/r', 'x.pdf', `${'a'.repeat(100)}.pdf`);
  assert.equal(long.length, 60 + 1 + 8);
});

test('scan: md5 cached on second scan', async () => {
  let n = 0;
  const md5 = async () => { n++; return 'a'.repeat(32); };
  const d = path.join(tmp, 'cache-data');
  await scanFolders([root], { dataDir: d, md5 });
  assert.equal(n, 3);
  n = 0;
  await scanFolders([root], { dataDir: d, md5 });
  assert.equal(n, 0);
});

test('scan: missing folder is reported, others still scanned', async () => {
  const gone = path.join(tmp, 'gone');
  const { files, problems } = await scanFolders([gone, root], { dataDir });
  assert.equal(files.length, 3);
  assert.deepEqual(problems, [{ folder: gone, message: `폴더를 찾을 수 없습니다: ${gone}` }]);
});

test('settings: round trip and validation messages', async () => {
  const d = path.join(tmp, 'settings-data');
  assert.deepEqual(await readSettings(d), { folders: [] });
  await writeSettings(d, { folders: [root] });
  assert.deepEqual(await readSettings(d), { folders: [root] });
  await assert.rejects(writeSettings(d, { folders: ['relative/x'] }), { message: '절대 경로를 입력하세요.' });
  const gone = path.join(tmp, 'nope');
  await assert.rejects(writeSettings(d, { folders: [gone] }), { message: `폴더를 찾을 수 없습니다: ${gone}` });
  await assert.rejects(writeSettings(d, { folders: Array(11).fill(root) }), { message: '폴더는 10개까지 지정할 수 있습니다.' });
  assert.deepEqual(await readSettings(d), { folders: [root] });
});

async function withServer(extra, fn) {
  const server = createServer({ outputDir: outDir, dataDir, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { examplesDir: path.join(tmp, 'no-examples'), ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const putJson = (base, body, headers = { 'content-type': 'application/json' }) => fetch(`${base}/api/library/folders`, { method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('API: folders PUT/GET, 415 guard, validation 400', async () => {
  await withServer({}, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/library/folders`)).json(), { folders: [] });
    assert.equal((await putJson(base, '{}', { 'content-type': 'text/plain' })).status, 415);
    const bad = await putJson(base, { folders: ['rel'] });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, '절대 경로를 입력하세요.');
    const ok = await putJson(base, { folders: [root] });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { folders: [root] });
    assert.deepEqual(await (await fetch(`${base}/api/library/folders`)).json(), { folders: [root] });
    await fs.rm(path.join(dataDir, 'settings.json'));
  });
});

test('API: merged list dedupes extracted bundles by md5 / path, flags missing folders', async () => {
  const gone = path.join(tmp, 'ext-disk');
  await fs.mkdir(path.join(outDir, 'done1'), { recursive: true });
  const { files } = await scanFolders([root], { dataDir });
  const dup = files.find((f) => f.rel === 'a/same.pdf');
  const byPath = files.find((f) => f.rel === 'b/same.pdf');
  await fs.writeFile(path.join(outDir, 'done1', 'source.json'), JSON.stringify({ id: 'done1', meta: { title: 'Done' }, pdf: { path: '/old/place.pdf', md5: dup.md5 } }));
  await fs.writeFile(path.join(outDir, 'done1', 'digest.json'), '{"version":1,"paperId":"done1","cards":[],"glossary":[]}');
  await fs.mkdir(path.join(outDir, 'done2'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'done2', 'source.json'), JSON.stringify({ id: 'done2', meta: { title: 'ByPath' }, pdf: { path: byPath.path } }));
  await writeSettings(dataDir, { folders: [root] });
  await fs.mkdir(gone);
  await writeSettings(dataDir, { folders: [root, gone] });
  await fs.rmdir(gone);
  try {
    await withServer({}, async (base) => {
      const { papers, folders } = await (await fetch(`${base}/api/papers`)).json();
      assert.deepEqual(folders, [{ path: root, ok: true }, { path: gone, ok: false, message: `폴더를 찾을 수 없습니다: ${gone}` }]);
      const pdfOnly = papers.filter((p) => p.state === 'pdf');
      assert.deepEqual(pdfOnly.map((p) => p.file), ['한글 이름 논문.PDF']);
      assert.equal(pdfOnly[0].origin, 'folder');
      assert.equal(pdfOnly[0].title, '한글 이름 논문.PDF');
      assert.equal(papers.filter((p) => p.id === 'done1').length, 1);
      assert.equal(papers.find((p) => p.id === 'done1').state, 'digest');
      assert.equal(papers.find((p) => p.id === 'done2').state, 'extracted');
    });
  } finally {
    await fs.rm(path.join(dataDir, 'settings.json'), { force: true });
  }
});
