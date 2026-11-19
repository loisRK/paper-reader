import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, HttpError } from '../src/http.mjs';

function fake(responses, calls = []) {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      json: async () => r.body,
    };
  };
}

test('fetchJson returns parsed body on 200', async () => {
  const calls = [];
  const out = await fetchJson('u', { fetchImpl: fake([{ status: 200, body: { a: 1 } }], calls), headers: { 'x-a': 'b' } });
  assert.deepEqual(out, { a: 1 });
  assert.equal(calls[0].init.headers['x-a'], 'b');
});

test('fetchJson retries 429 honoring retryAfter body', async () => {
  const calls = []; const sleeps = [];
  const fetchImpl = fake([{ status: 429, body: { retryAfter: 38 } }, { status: 200, body: { ok: 1 } }], calls);
  assert.deepEqual(await fetchJson('u', { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } }), { ok: 1 });
  assert.deepEqual(sleeps, [38000]);
  assert.equal(calls.length, 2);
});

test('fetchJson honors Retry-After header', async () => {
  const sleeps = [];
  const fetchImpl = fake([{ status: 503, headers: { 'Retry-After': '7' } }, { status: 200, body: {} }]);
  await fetchJson('u', { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [7000]);
});

test('fetchJson uses 2s/4s/8s backoff for 5xx then throws HttpError', async () => {
  const calls = []; const sleeps = [];
  const fetchImpl = fake([{ status: 500 }], calls);
  await assert.rejects(
    fetchJson('http://x/y', { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } }),
    (e) => e instanceof HttpError && e.status === 500 && e.url === 'http://x/y',
  );
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
  assert.equal(calls.length, 4);
});

test('fetchJson throws HttpError on 404 without retry', async () => {
  const calls = []; const sleeps = [];
  const fetchImpl = fake([{ status: 404 }], calls);
  await assert.rejects(
    fetchJson('u', { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } }),
    (e) => e instanceof HttpError && e.status === 404,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});
