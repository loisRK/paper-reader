export const redactUrl = (url) => String(url).replace(/([?&](?:api_key|mailto)=)[^&#]*/gi, '$1***');

export class HttpError extends Error {
  constructor(status, url, message) {
    url = redactUrl(url);
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryDelayMs(res, attempt) {
  const header = Number(res.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  if (res.status === 429) {
    try {
      const body = await res.json();
      const sec = Number(body?.retryAfter);
      if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    } catch { /* body is not JSON */ }
  }
  return 2000 * 2 ** attempt; // 2s, 4s, 8s
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
};

export async function fetchJson(url, opts = {}) {
  const { fetchImpl = globalThis.fetch, headers = {}, retries = 3, sleep = defaultSleep } = opts;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers } });
    } catch (err) {
      // fetch() rejects with TypeError on DNS/connection failures: retry like 5xx.
      if (!(err instanceof TypeError)) throw err;
      if (attempt >= retries) {
        throw new Error(`서버에 연결하지 못했습니다. 네트워크 연결을 확인하세요 (${hostOf(url)})`, { cause: err });
      }
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new HttpError(res.status, url);
    await sleep(await retryDelayMs(res, attempt));
  }
}
