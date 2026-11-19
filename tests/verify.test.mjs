import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWork } from '../src/search/verify.mjs';
import { DEFAULTS } from '../src/config.mjs';

const cfg = structuredClone(DEFAULTS);
const work = { doi: '10.1109/tpami.2025.3529084', title: 'T' };
const good = { type: 'journal-article', ISSN: ['0162-8828'], 'container-title': ['IEEE Transactions on Pattern Analysis'] };

// Routes Crossref (JSON) and doi.org (HEAD) requests.
function mock({ crossref = good, crossrefStatus = 200, doi = { status: 302, location: 'https://publisher.example/x' }, throwAll = false } = {}) {
  return async (url, init = {}) => {
    if (throwAll) throw new Error('network down');
    if (String(url).startsWith('https://api.crossref.org/works/')) {
      return { ok: crossrefStatus === 200, status: crossrefStatus, headers: { get: () => null }, json: async () => ({ message: crossref }) };
    }
    assert.equal(init.method, 'HEAD');
    assert.equal(init.redirect, 'manual');
    return { ok: false, status: doi.status, headers: { get: (k) => (k.toLowerCase() === 'location' ? doi.location ?? null : null) } };
  };
}
const run = (opts, w = work) => verifyWork(w, cfg, { fetchImpl: mock(opts), sleep: async () => {} });

test('journal article with resolving DOI passes', async () => {
  const r = await run();
  assert.deepEqual(r, { ok: true, reason: null, verification: { crossrefType: 'journal-article', doiResolves: true } });
});
test('missing DOI is rejected', async () => {
  const r = await run({}, { ...work, doi: null });
  assert.equal(r.ok, false); assert.equal(r.reason, 'DOI 없음');
});
test('non journal-article type is rejected', async () => {
  const r = await run({ crossref: { ...good, type: 'proceedings-article' } });
  assert.equal(r.ok, false); assert.equal(r.reason, 'Crossref 유형: proceedings-article');
  assert.equal(r.verification.crossrefType, 'proceedings-article');
});
test('missing ISSN is rejected', async () => {
  const r = await run({ crossref: { ...good, ISSN: [] } });
  assert.equal(r.ok, false); assert.equal(r.reason, 'ISSN 없음');
});
test('proceedings-series ISSN is rejected', async () => {
  const r = await run({ crossref: { type: 'journal-article', ISSN: ['03029743'], 'container-title': ['Lecture Notes in Computer Science'] } });
  assert.equal(r.ok, false); assert.match(r.reason, /0302-9743/);
});
test('conference-like container title is rejected', async () => {
  const r = await run({ crossref: { ...good, 'container-title': ['Proceedings of the Foo Workshop'] } });
  assert.equal(r.ok, false); assert.equal(r.reason, '학회 proceedings로 보임');
});
test('DOI that does not redirect is rejected', async () => {
  const r = await run({ doi: { status: 404 } });
  assert.equal(r.ok, false); assert.equal(r.reason, 'DOI가 출판사 페이지로 연결되지 않음');
  assert.equal(r.verification.doiResolves, false);
});
test('Crossref 404 means unregistered DOI', async () => {
  const r = await run({ crossrefStatus: 404 });
  assert.equal(r.ok, false); assert.equal(r.reason, 'Crossref에 등록되지 않은 DOI');
});
test('network failure is not treated as pass', async () => {
  const r = await run({ throwAll: true });
  assert.equal(r.ok, false); assert.match(r.reason, /확인 실패/);
});
