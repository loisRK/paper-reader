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

async function call(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
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
    res = await fetchImpl(`${baseUrl(cfg)}/api/`);
  } catch {
    return { running: false, serverId: null, version: null, writable: false };
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

  async function ensureInfo() {
    if (!info) {
      let res;
      try {
        res = await fetchImpl(`${base}/api/`);
      } catch {
        throw new ZoteroWriteError('offline', NOT_RUNNING_MESSAGE);
      }
      info = parseInfo(res);
    }
    if (!info.writable) throw new ZoteroWriteError('readonly', READONLY_MESSAGE);
    return info;
  }

  const serverId = async () => (await ensureInfo()).serverId;

  async function dropKeys(id) {
    onceKey = null;
    await authStore.clear(id);
  }

  // 412 on a response: other server => server-changed, same server => version conflict.
  async function check412(res, id) {
    const seen = res.headers.get('Zotero-Server-ID');
    if (seen && seen !== id) {
      await dropKeys(id);
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
    });
    if (res.status === 403) throw new ZoteroWriteError('denied', 'Zotero에서 접근이 거부되었습니다.', { status: 403 });
    if (res.status === 429) {
      const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      throw new ZoteroWriteError('rate-limited', 'Zotero 인가 요청이 너무 잦습니다.', {
        status: 429, ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
      });
    }
    if (res.status === 412) await check412(res, id);
    if (res.status !== 200) throw new ZoteroWriteError('http', `Zotero 인가 실패: HTTP ${res.status}`, { status: res.status });
    const { key, remember } = await res.json();
    if (remember) await authStore.set(id, key);
    else onceKey = key;
    return { remember: Boolean(remember) };
  }

  // Authenticated write. Returns the response on 2xx, throws otherwise.
  async function write(method, pathname, { body, headers = {} } = {}) {
    const id = await serverId();
    const key = onceKey ?? (await authStore.get(id));
    if (!key) throw new ZoteroWriteError('needs-auth', 'Zotero 인가가 필요합니다.');
    onceKey = null; // single-use keys are consumed by the attempt
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
    return res;
  }

  async function read(pathname, headers = {}) {
    const id = info?.serverId;
    const res = await call(fetchImpl, `${base}${pathname}`, {
      headers: { ...(id ? { 'Zotero-Server-ID': id } : {}), ...headers },
    });
    if (res.status === 412 && id) await check412(res, id);
    return res;
  }

  return {
    serverId,
    authorize,
    async createItems(items) {
      const res = await write('POST', '/api/users/0/items', { body: items });
      const out = await res.json();
      return { success: out.success ?? {}, successful: out.successful ?? {}, failed: out.failed ?? {} };
    },
    async patchItem(key, version, data) {
      const res = await write('PATCH', `/api/users/0/items/${key}`, {
        body: data,
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      return Number.parseInt(res.headers.get('Last-Modified-Version') ?? '', 10);
    },
    async deleteItem(key, version) {
      await write('DELETE', `/api/users/0/items/${key}`, {
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
    },
    async getItem(key) {
      await ensureInfo();
      const res = await read(`/api/users/0/items/${key}?format=json`);
      if (res.status === 404) return null;
      if (!res.ok) throw new ZoteroWriteError('http', `Zotero 조회 실패: HTTP ${res.status}`, { status: res.status });
      return res.json();
    },
    async listChildren(parentKey, sinceVersion) {
      await ensureInfo();
      const res = await read(
        `/api/users/0/items/${parentKey}/children?format=json`,
        sinceVersion !== undefined ? { 'If-Modified-Since-Version': String(sinceVersion) } : {},
      );
      const libraryVersion = Number.parseInt(res.headers.get('Last-Modified-Version') ?? '', 10);
      if (res.status === 304) return { items: [], libraryVersion, notModified: true };
      if (!res.ok) throw new ZoteroWriteError('http', `Zotero 조회 실패: HTTP ${res.status}`, { status: res.status });
      return { items: await res.json(), libraryVersion, notModified: false };
    },
  };
}
