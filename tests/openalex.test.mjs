import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { searchWorks, normalizeWork } from '../src/search/openalex.mjs';
import { DEFAULTS } from '../src/config.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/openalex-page.json', import.meta.url), 'utf8'));

const cfg = (search = {}) => ({ ...structuredClone(DEFAULTS), search: { ...structuredClone(DEFAULTS.search), ...search } });

function pagedFetch(pages, calls) {
  let i = 0;
  return async (url) => {
    calls.push(url);
    const body = pages[Math.min(i++, pages.length - 1)];
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => body };
  };
}

test('normalizeWork rebuilds abstract and strips doi prefix', () => {
  const w = normalizeWork(fixture.results[0]);
  assert.equal(w.doi, '10.1109/tpami.2025.3529084');
  assert.match(w.abstract, /^Detecting 3D objects/);
  assert.equal(w.abstract, 'Detecting 3D objects is hard; we 3D propose transformers.');
  assert.equal(w.oaPdfUrl, null);
  assert.equal(w.openalexId, 'https://openalex.org/W4406000001');
  assert.deepEqual(w.authors, ['Alice Kim', 'Bob Lee']);
  assert.equal(w.journal, 'IEEE Transactions on Pattern Analysis and Machine Intelligence');
  assert.deepEqual(w.issn, ['0162-8828', '1939-3539']);
  assert.equal(w.publicationDate, '2025-01-14');
  assert.equal(w.citedBy, 42);
  assert.deepEqual(w.countsByYear, [{ year: 2026, count: 30 }, { year: 2025, count: 12 }]);
  assert.deepEqual(w.topic, { id: 'https://openalex.org/T10531', name: 'Advanced Vision and Imaging' });
  assert.equal(normalizeWork(fixture.results[1]).oaPdfUrl, 'https://example.org/paper.pdf');
});

test('normalizeWork tolerates missing fields', () => {
  const w = normalizeWork({ id: 'https://openalex.org/W1', title: 't' });
  assert.equal(w.doi, null);
  assert.equal(w.abstract, '');
  assert.deepEqual(w.authors, []);
  assert.equal(w.journal, null);
  assert.deepEqual(w.issn, []);
  assert.equal(w.topic, null);
  assert.equal(w.oaPdfUrl, null);
  assert.equal(w.citedBy, 0);
});

test('searchWorks builds filter with from_publication_date = now - 24 months and follows cursor', async () => {
  const calls = [];
  const last = { meta: { next_cursor: null }, results: [fixture.results[1]] };
  const fetchImpl = pagedFetch([fixture, last], calls);
  const works = await searchWorks('3d detection', cfg({ openalexApiKey: 'KEY', contactEmail: 'a@b.c' }), {
    fetchImpl, now: new Date('2026-11-18T12:00:00Z'),
  });
  assert.equal(works.length, 3);
  assert.equal(calls.length, 2);
  const u1 = new URL(calls[0]);
  assert.equal(u1.origin + u1.pathname, 'https://api.openalex.org/works');
  assert.equal(u1.searchParams.get('search'), '3d detection');
  assert.equal(
    u1.searchParams.get('filter'),
    'type:article,primary_location.source.type:journal,is_retracted:false,from_publication_date:2024-11-18',
  );
  assert.equal(u1.searchParams.get('per-page'), '200');
  assert.equal(u1.searchParams.get('cursor'), '*');
  assert.equal(u1.searchParams.get('api_key'), 'KEY');
  assert.equal(u1.searchParams.get('mailto'), 'a@b.c');
  assert.equal(new URL(calls[1]).searchParams.get('cursor'), 'IlsxNzY0XSI=');
});

test('searchWorks omits api_key/mailto when unset and stops at maxResults', async () => {
  const calls = [];
  const fetchImpl = pagedFetch([fixture], calls);
  const works = await searchWorks('q', cfg({ maxResults: 1 }), { fetchImpl, now: new Date('2026-11-18T00:00:00Z') });
  assert.equal(works.length, 1);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.has('api_key'), false);
  assert.equal(u.searchParams.has('mailto'), false);
});

test('searchWorks stops on empty results', async () => {
  const calls = [];
  const fetchImpl = pagedFetch([{ meta: { next_cursor: 'x' }, results: [] }], calls);
  const works = await searchWorks('q', cfg(), { fetchImpl, now: new Date('2026-11-18T00:00:00Z') });
  assert.deepEqual(works, []);
  assert.equal(calls.length, 1);
});
