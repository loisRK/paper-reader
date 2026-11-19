import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

async function tmpDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-cfg-')));
}

test('defaults when file missing', async () => {
  const c = await loadConfig('/nonexistent/paper-reader.config.json');
  assert.equal(c.search.perTrend, 5);
  assert.equal(c.reader.port, 5173);
  assert.ok(path.isAbsolute(c.outputDir));
  assert.equal(c.dataDir, '/nonexistent/data');
  assert.ok(path.isAbsolute(c.metrics.sjrCsv));
  assert.equal(c.metrics.mjlCsv, null);
  assert.equal('researchContextFile' in c, false);
});

test('merges nested values and resolves relative paths from config dir', async () => {
  const tmp = await tmpDir();
  const dir = path.join(tmp, 'cfg');
  await fs.mkdir(dir);
  const file = path.join(dir, 'paper-reader.config.json');
  await fs.writeFile(file, JSON.stringify({
    outputDir: '../out',
    search: { perTrend: 3, excludedIssns: ['1111-1111'] },
    metrics: { mjlCsv: 'mjl.csv' },
    researchContextFile: 'ctx.md',
  }));
  const c = await loadConfig(file);
  assert.equal(c.search.perTrend, 3);
  assert.equal(c.search.emergingWindowMonths, 6);
  assert.deepEqual(c.search.excludedIssns, ['1111-1111']);
  assert.equal(c.outputDir, path.join(tmp, 'out'));
  assert.equal(c.metrics.mjlCsv, path.join(dir, 'mjl.csv'));
  assert.equal(c.metrics.sjrCsv, path.join(dir, 'data', 'scimagojr.csv'));
  // The removed research-context setting is ignored silently, not an error.
  assert.equal('researchContextFile' in c, false);
});

test('invalid JSON throws with file path in message', async () => {
  const tmp = await tmpDir();
  const file = path.join(tmp, 'paper-reader.config.json');
  await fs.writeFile(file, '{ not json');
  await assert.rejects(loadConfig(file), /paper-reader\.config\.json/);
});

test('config errors are Korean', async () => {
  const tmp = await tmpDir();
  const file = path.join(tmp, 'paper-reader.config.json');
  await fs.writeFile(file, '{ not json');
  await assert.rejects(loadConfig(file), (e) => /JSON 형식이 올바르지 않습니다/.test(e.message) && e.message.includes(file));
  await fs.writeFile(file, '[]');
  await assert.rejects(loadConfig(file), /최상위 값은 객체여야 합니다/);
  await assert.rejects(loadConfig(tmp), /읽을 수 없습니다/);
});
