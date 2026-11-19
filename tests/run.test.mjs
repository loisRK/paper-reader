import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSearch, slugify } from '../src/search/run.mjs';
import { DEFAULTS } from '../src/config.mjs';

const now = new Date('2026-11-18T00:00:00Z');
const okV = { crossrefType: 'journal-article', doiResolves: true };
let k = 0;
const mk = (o = {}) => ({
  openalexId: `W${++k}`, doi: `10.1/${k}`, title: `T${k}`, abstract: '', authors: [], journal: `J${k}`, issn: ['0162-8828'],
  publicationDate: '2026-01-10', citedBy: 100 - k, countsByYear: [{ year: 2026, count: 100 - k }], topic: null, oaPdfUrl: null, ...o,
});
async function cfgTmp() {
  const cfg = structuredClone(DEFAULTS);
  cfg.outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-'));
  return cfg;
}
const metricsIndex = { sjr: new Map(), mjl: new Map() };

test('slugify', () => assert.equal(slugify('  AIOps & 이상탐지! '), 'aiops-이상탐지'));

test('runSearch moves unverified papers to excluded with reason and backfills', async () => {
  const cfg = await cfgTmp();
  const works = Array.from({ length: 8 }, () => mk());
  const badId = works[0].openalexId;
  const calls = [];
  const verify = async (w) => {
    calls.push(w.openalexId);
    return w.openalexId === badId
      ? { ok: false, reason: 'Crossref 유형: proceedings-article', verification: { crossrefType: 'proceedings-article', doiResolves: null } }
      : { ok: true, reason: null, verification: okV };
  };
  const r = await runSearch('AIOps', cfg, { now, verify, search: async () => works, metricsIndex });
  assert.equal(r.excluded[0].reason, 'Crossref 유형: proceedings-article');
  assert.equal(r.sections.citationSurge.papers.length, 5);
  assert.equal(new Set(calls).size, calls.length);
  assert.ok(r.papers.every((p) => p.verification.crossrefType === 'journal-article'));
  assert.ok(!r.papers.some((p) => p.openalexId === badId));
  const saved = JSON.parse(await fs.readFile(r.path, 'utf8'));
  assert.equal(saved.papers.length, r.papers.length);
  assert.match(path.basename(r.path), /^2026-11-18-aiops\.json$/);
});

test('runSearch with zero OpenAlex results writes file with notes, no throw', async () => {
  const cfg = await cfgTmp();
  const r = await runSearch('nothing', cfg, { now, search: async () => [], verify: async () => { throw new Error('no'); }, metricsIndex });
  assert.equal(r.papers.length, 0);
  assert.match(r.sections.citationSurge.note, /0편/);
  await fs.access(r.path);
});

test('budget exhaustion: verify calls capped, unverified absent, notes recomputed', async () => {
  const cfg = await cfgTmp();
  const works = Array.from({ length: 30 }, () => mk());
  const calls = [];
  const verify = async (w) => {
    calls.push(w.openalexId);
    return calls.length <= 2
      ? { ok: true, reason: null, verification: okV }
      : { ok: false, reason: 'Crossref 유형: proceedings-article', verification: { crossrefType: 'proceedings-article', doiResolves: null } };
  };
  const r = await runSearch('x', cfg, { now, verify, search: async () => works, metricsIndex });
  assert.ok(calls.length <= cfg.search.perTrend * 3);
  assert.equal(calls.length, cfg.search.perTrend * 3);
  assert.equal(r.papers.length, 2);
  assert.ok(r.papers.every((p) => calls.includes(p.openalexId)));
  assert.match(r.sections.citationSurge.note, /2편뿐/);
  assert.equal(r.excluded.length, calls.length - 2);
});

test('CLI error message redacts secrets and gives Korean guidance', async () => {
  const { HttpError } = await import('../src/http.mjs');
  const { cliErrorMessage } = await import('../src/search/run.mjs');
  const err = new HttpError(401, 'https://api.openalex.org/works?search=a&api_key=SECRET123&mailto=me@x.com');
  assert.ok(!err.message.includes('SECRET123') && !err.url.includes('me@x.com'));
  const msg = cliErrorMessage(err);
  assert.ok(!msg.includes('api_key='));
  assert.match(msg, /openalexApiKey/);
});
