import fs from 'node:fs/promises';
import path from 'node:path';
import { NOT_RUNNING_MESSAGE } from './local.mjs';

const baseUrl = (cfg) => String(cfg.zotero.baseUrl).replace(/\/+$/, '');

export class ZoteroWriteError extends Error {
  // code: 'offline'|'denied'|'rate-limited'|'server-changed'|'readonly'|'needs-auth'|'http'
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ZoteroWriteError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
  }
}

const READONLY_MESSAGE = 'Zotero 10 이상이 필요합니다. 쓰기(동기화)를 사용할 수 없습니다.';

// Every request is bounded so a hung Zotero cannot hold a paper's sync chain forever.
export const TIMEOUT_MS = 10000;
export const AUTHORIZE_TIMEOUT_MS = 120000; // the user is clicking Zotero's dialog

// Network failure, abort or timeout -> 'offline'.
async function call(fetchImpl, url, init = {}, ms = TIMEOUT_MS) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch {
    throw new ZoteroWriteError('offline', NOT_RUNNING_MESSAGE);
  }
}

function parseInfo(res) {
  const serverId = res.headers.get('Zotero-Server-ID') || null;
  const version = res.headers.get('X-Zotero-Version') || null;
  const major = Number.parseInt(version ?? '', 10);
  return { running: true, serverId, version, writable: Boolean(serverId) && major >= 10 };
}

export async function getServerInfo(cfg, opts = {}) {
  const { fetchImpl = globalThis.fetch } = opts;
  let res;
  try {
    res = await fetchImpl(`${baseUrl(cfg)}/api/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { running: false, serverId: null, version: null, writable: false };
  }
  // e.g. 403 when "allow other applications to communicate with Zotero" is off: not usable.
  if (!res.ok) {
    return {
      running: false, serverId: null, version: null, writable: false,
      message: `Zotero 로컬 API가 응답하지 않습니다(HTTP ${res.status}). Zotero 설정에서 로컬 API를 켜 주세요.`,
    };
  }
  return parseInfo(res);
}

export function fileAuthStore(file) {
  const read = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) return {};
      throw err;
    }
  };
  const write = async (data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  };
  return {
    get: async (serverId) => (await read())[serverId] ?? null,
    set: async (serverId, key) => write({ ...(await read()), [serverId]: key }),
    clear: async (serverId) => {
      const data = await read();
      if (!(serverId in data)) return;
      delete data[serverId];
      await write(data);
    },
  };
}

export function createZoteroWriter(cfg, opts = {}) {
  const { fetchImpl = globalThis.fetch } = opts;
  const authStore = opts.authStore ?? fileAuthStore(cfg.zotero.authFile);
  const base = baseUrl(cfg);
  let info = null;
  let onceKey = null; // remember:false key, consumed by the next write

  // Reads need only a running Zotero (Zotero 7–9 may report no server id).
  async function ensureRunning() {
    if (!info) info = parseInfo(await call(fetchImpl, `${base}/api/`));
    return info;
  }

  // Writes and authorize need Zotero 10+.
  async function ensureInfo() {
    await ensureRunning();
    if (!info.writable) throw new ZoteroWriteError('readonly', READONLY_MESSAGE);
    return info;
  }

  const serverId = async () => (await ensureInfo()).serverId;

  async function dropKeys(id) {
    onceKey = null;
    await authStore.clear(id);
  }

  // 412 on a response: other server => server-changed, same server => version conflict.
  // Reads only reset the cached info: stored keys are per server id, so they stay valid.
  async function check412(res, id, { keepKeys = false } = {}) {
    const seen = res.headers.get('Zotero-Server-ID');
    if (seen && seen !== id) {
      if (!keepKeys) await dropKeys(id);
      info = null;
      throw new ZoteroWriteError('server-changed', 'Zotero 서버가 바뀌었습니다. 다시 인가해 주세요.', { status: 412 });
    }
    throw new ZoteroWriteError('http', 'Zotero 항목 버전 충돌 (412)', { status: 412 });
  }

  async function authorize() {
    const id = await serverId();
    const res = await call(fetchImpl, `${base}/api/local/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': id },
      body: JSON.stringify({ appName: 'Paper Reader' }),
    }, AUTHORIZE_TIMEOUT_MS);
    if (res.status === 403) throw new ZoteroWriteError('denied', 'Zotero에서 접근이 거부되었습니다.', { status: 403 });
    if (res.status === 429) {
      const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      throw new ZoteroWriteError('rate-limited', 'Zotero 인가 요청이 너무 잦습니다.', {
        status: 429, ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
      });
    }
    if (res.status === 412) await check412(res, id);
    if (res.status !== 200) throw new ZoteroWriteError('http', `Zotero 인가 실패: HTTP ${res.status}`, { status: res.status });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new ZoteroWriteError('http', 'Zotero 인가 응답을 해석할 수 없습니다.', { status: res.status });
    }
    const { key, remember } = body ?? {};
    if (typeof key !== 'string' || !key) {
      throw new ZoteroWriteError('http', 'Zotero 인가 응답에 키가 없습니다.', { status: res.status });
    }
    if (remember) await authStore.set(id, key);
    else onceKey = key;
    return { remember: Boolean(remember) };
  }

  // Authenticated write. Returns the response on 2xx, throws otherwise.
  async function write(method, pathname, { body, headers = {} } = {}) {
    const id = await serverId();
    const key = onceKey ?? (await authStore.get(id));
    if (!key) throw new ZoteroWriteError('needs-auth', 'Zotero 인가가 필요합니다.');
    const res = await call(fetchImpl, `${base}${pathname}`, {
      method,
      headers: {
        'Zotero-API-Key': key,
        'Zotero-Server-ID': id,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) {
      await dropKeys(id);
      throw new ZoteroWriteError('needs-auth', 'Zotero 인가 키가 유효하지 않습니다. 다시 인가해 주세요.', { status: 401 });
    }
    if (res.status === 412) await check412(res, id);
    if (!res.ok) throw new ZoteroWriteError('http', `Zotero 쓰기 실패: HTTP ${res.status}`, { status: res.status });
    // Single-use key is consumed only on success (or 401/server-changed, handled above).
    if (onceKey === key) onceKey = null;
    return res;
  }

  async function read(pathname, headers = {}) {
    const id = info?.serverId;
    const res = await call(fetchImpl, `${base}${pathname}`, {
      headers: { ...(id ? { 'Zotero-Server-ID': id } : {}), ...headers },
    });
    if (res.status === 412 && id) await check412(res, id, { keepKeys: true });
    return res;
  }

  return {
    serverId,
    authorize,
    // Forget cached server info only (a long-lived writer must notice Zotero restarts/upgrades).
    // The single-use onceKey is kept.
    resetInfo() {
      info = null;
    },
    async createItems(items) {
      const res = await write('POST', '/api/users/0/items', { body: items });
      const out = await res.json();
      return { success: out.success ?? {}, successful: out.successful ?? {}, failed: out.failed ?? {} };
    },
    // Returns the new item version, or null if Zotero sent no valid Last-Modified-Version
    // (caller should then refetch via getItem instead of storing a bogus version).
    async patchItem(key, version, data) {
      const res = await write('PATCH', `/api/users/0/items/${key}`, {
        body: data,
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      const v = Number.parseInt(res.headers.get('Last-Modified-Version') ?? '', 10);
      return Number.isFinite(v) ? v : null;
    },
    async deleteItem(key, version) {
      await write('DELETE', `/api/users/0/items/${key}`, {
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
    },
    async getItem(key) {
      await ensureRunning();
      const res = await read(`/api/users/0/items/${key}?format=json`);
      if (res.status === 404) return null;
      if (!res.ok) throw new ZoteroWriteError('http', `Zotero 조회 실패: HTTP ${res.status}`, { status: res.status });
      return res.json();
    },
    // Zotero's local API omits annotation children unless itemType=annotation is requested.
    async listChildren(parentKey, sinceVersion, { itemType } = {}) {
      await ensureRunning();
      const filter = itemType ? `&itemType=${encodeURIComponent(itemType)}` : '';
      const res = await read(
        `/api/users/0/items/${parentKey}/children?format=json${filter}`,
        sinceVersion !== undefined ? { 'If-Modified-Since-Version': String(sinceVersion) } : {},
      );
      const libraryVersion = Number.parseInt(res.headers.get('Last-Modified-Version') ?? '', 10);
      if (res.status === 304) return { items: [], libraryVersion, notModified: true };
      if (!res.ok) throw new ZoteroWriteError('http', `Zotero 조회 실패: HTTP ${res.status}`, { status: res.status });
      return { items: await res.json(), libraryVersion, notModified: false };
    },
  };
}
