import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMetrics, lookupMetrics } from '../src/search/metrics.mjs';

const fx = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
const cfg = (m) => ({ metrics: m });
const NULLS = { scopus: null, sjrQuartile: null, sjrYear: null, wos: null, scie: null, ssci: null };

test('matches SJR by any ISSN ignoring hyphen', async () => {
  const idx = await loadMetrics(cfg({ sjrCsv: fx('scimagojr-sample.csv'), sjrYear: 2025 }));
  for (const q of [['0018-9448'], ['1540-3459'], ['00189448']]) {
    const r = lookupMetrics(idx, q);
    assert.equal(r.scopus, true);
    assert.equal(r.sjrQuartile, 'Q1');
    assert.equal(r.sjrYear, 2025);
  }
});

test('quartile "-" gives null quartile but scopus true; X check digit works', async () => {
  const idx = await loadMetrics(cfg({ sjrCsv: fx('scimagojr-sample.csv') }));
  const r = lookupMetrics(idx, ['1234-5678']);
  assert.equal(r.scopus, true);
  assert.equal(r.sjrQuartile, null);
  assert.equal(lookupMetrics(idx, ['2049-363x']).sjrQuartile, 'Q3');
});

test('sjrYear derived from file name', async () => {
  const { mkdtemp, copyFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sjr-'));
  const f = path.join(dir, 'scimagojr-2024.csv');
  await copyFile(fx('scimagojr-sample.csv'), f);
  const idx = await loadMetrics(cfg({ sjrCsv: f }));
  assert.equal(lookupMetrics(idx, ['0018-9448']).sjrYear, 2024);
});

test('unknown journal stays null, never false', async () => {
  const idx = await loadMetrics(cfg({ sjrCsv: fx('scimagojr-sample.csv'), mjlCsv: fx('mjl-sample.csv') }));
  assert.deepEqual(lookupMetrics(idx, ['0000-0001']), NULLS);
  assert.deepEqual(lookupMetrics(idx, []), NULLS);
});

test('MJL marks SCIE and SSCI separately', async () => {
  const idx = await loadMetrics(cfg({ sjrCsv: null, mjlCsv: fx('mjl-sample.csv') }));
  const a = lookupMetrics(idx, ['3333-4444']);
  assert.deepEqual([a.wos, a.scie, a.ssci], [true, true, null]);
  const b = lookupMetrics(idx, ['5555-6666']);
  assert.deepEqual([b.wos, b.scie, b.ssci], [true, null, true]);
  const c = lookupMetrics(idx, ['7777-8888']);
  assert.deepEqual([c.wos, c.scie, c.ssci], [true, null, null]);
});

test('missing files yield empty index without throwing', async () => {
  const idx = await loadMetrics(cfg({ sjrCsv: '/nonexistent/x.csv', mjlCsv: '/nonexistent/y.csv' }));
  assert.deepEqual(lookupMetrics(idx, ['0018-9448']), NULLS);
  const idx2 = await loadMetrics({});
  assert.deepEqual(lookupMetrics(idx2, ['0018-9448']), NULLS);
});
