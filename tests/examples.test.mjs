import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDigest } from '../src/digest/validate.mjs';
import { createServer } from '../src/reader/server.mjs';
import { EXAMPLES_DIR, listPaperBundles, readPaper, writeProgress } from '../src/reader/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = path.join(ROOT, 'examples');
const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));

const exampleIds = (await fs.readdir(examplesDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory()).map((e) => e.name);

test('there is at least one example and EXAMPLES_DIR points at examples/', () => {
  assert.ok(exampleIds.length >= 1);
  assert.equal(EXAMPLES_DIR, examplesDir);
});

for (const id of exampleIds) {
  test(`example ${id}: source.json, digest.json valid with 0 problems`, async () => {
    const source = await readJson(path.join(examplesDir, id, 'source.json'));
    const digest = await readJson(path.join(examplesDir, id, 'digest.json'));
    assert.equal(source.extractorVersion, 1);
    assert.equal(source.id, id);
    assert.deepEqual(source.zotero, { itemKey: null, attachmentKey: null });
    assert.equal(digest.paperId, id);
    const { problems } = validateDigest(digest, source);
    assert.deepEqual(problems, []);
    await fs.access(path.join(examplesDir, id, 'README.md'));
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-examples-'));
  const out = path.join(root, 'out');
  const ex = path.join(root, 'examples');
  const write = async (dir, id, file, data) => {
    await fs.mkdir(path.join(dir, id), { recursive: true });
    await fs.writeFile(path.join(dir, id, file), JSON.stringify(data));
  };
  await write(out, 'mine', 'source.json', { id: 'mine', meta: { title: 'Mine' } });
  await write(ex, 'ex1', 'source.json', { id: 'ex1', meta: { title: 'Ex' } });
  await write(ex, 'ex1', 'digest.json', { version: 1, paperId: 'ex1', cards: [] });
  await write(ex, 'mine', 'source.json', { id: 'mine', meta: { title: 'Shadowed' } });
  return { root, out, ex };
}

test('listPaperBundles always includes examples, flagged, without shadowing own papers', async () => {
  const { root, out, ex } = await fixture();
  try {
    const list = await listPaperBundles(out, { examplesDir: ex });
    assert.deepEqual(list.map((b) => [b.id, b.example]), [['ex1', true], ['mine', false]]);
    assert.equal(list.find((b) => b.id === 'mine').source.meta.title, 'Mine');
    // Empty/missing outputDir still lists examples.
    const onlyEx = await listPaperBundles(path.join(root, 'nope'), { examplesDir: ex });
    assert.deepEqual(onlyEx.map((b) => [b.id, b.example]), [['ex1', true], ['mine', true]]);
    // Missing examples dir is fine.
    assert.deepEqual((await listPaperBundles(out, { examplesDir: path.join(root, 'none') })).map((b) => b.id), ['mine']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('readPaper falls back to examples; progress is stored in outputDir, not examples/', async () => {
  const { root, out, ex } = await fixture();
  try {
    const b = await readPaper(out, 'ex1', { examplesDir: ex });
    assert.equal(b.example, true);
    assert.equal(b.rawDigest.paperId, 'ex1');
    assert.deepEqual(b.progress, { read: [], mode: '10min', focus: false });
    const prog = { read: ['c1'], mode: '3min', focus: true };
    await writeProgress(out, 'ex1', prog);
    assert.deepEqual(await readJson(path.join(out, 'ex1', 'progress.json')), prog);
    await assert.rejects(fs.access(path.join(ex, 'ex1', 'progress.json')));
    assert.deepEqual((await readPaper(out, 'ex1', { examplesDir: ex })).progress, prog);
    // A progress-only folder in outputDir is not listed as an own paper.
    assert.deepEqual((await listPaperBundles(out, { examplesDir: ex })).map((x) => [x.id, x.example]), [['ex1', true], ['mine', false]]);
    assert.equal((await readPaper(out, 'mine', { examplesDir: ex })).example, false);
    assert.equal(await readPaper(out, 'nope', { examplesDir: ex }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('server lists examples with example flag, null Zotero links, and saves their progress', async () => {
  const { root, out, ex } = await fixture();
  const server = createServer({ outputDir: out, reader: { port: 0 }, zotero: { baseUrl: 'http://127.0.0.1:1' } }, { examplesDir: ex });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/papers`)).json();
    assert.deepEqual(list.map((p) => [p.id, p.example]), [['ex1', true], ['mine', false]]);
    const body = await (await fetch(`${base}/api/papers/ex1`)).json();
    assert.deepEqual(body.links, { zoteroPdf: null, pdf: false, zoteroItem: null });
    const res = await fetch(`${base}/api/papers/ex1/progress`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read: [], mode: '3min', focus: false }),
    });
    assert.equal(res.status, 204);
    await fs.access(path.join(out, 'ex1', 'progress.json'));
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
