import fs from 'node:fs/promises';
import path from 'node:path';
import { zget, toMeta, fileUrlToLocalPath } from './local.mjs';
import { md5File as defaultMd5File } from '../library/scan.mjs';

const PAGE = 100;
const nfc = (s) => String(s).normalize('NFC');
const sharedCache = new Map(); // baseUrl -> { version, index }

function attachmentFileName(data) {
  const p = typeof data?.path === 'string' ? data.path : '';
  const m = p.match(/^(?:attachments|storage):(.*)$/s);
  const name = m ? m[1] : data?.filename ?? '';
  return nfc(path.basename(String(name).replace(/\\/g, '/')));
}

// file name (NFC) -> [{ key, parent }] over all Zotero PDF attachments.
// Page 1 is always requested (it carries Last-Modified-Version); later pages only when the version changed.
async function attachmentIndex(cfg, fetchImpl, cache) {
  const slot = cache ?? sharedCache;
  const get = (k) => (slot instanceof Map ? slot.get(k) : slot[k]);
  const set = (k, v) => (slot instanceof Map ? slot.set(k, v) : (slot[k] = v));
  const cacheKey = String(cfg.zotero.baseUrl);
  const q = (start) => `items?itemType=attachment&format=json&limit=${PAGE}&start=${start}`;

  const first = await zget(cfg, fetchImpl, q(0));
  if (!first.ok) throw new Error(`HTTP ${first.status}`);
  const version = first.headers?.get?.('Last-Modified-Version') ?? null;
  const cached = get(cacheKey);
  if (version !== null && cached?.version === version) return cached.index;

  const rows = [];
  let page = await first.json();
  for (let start = 0; ; start += PAGE) {
    if (!Array.isArray(page)) break;
    rows.push(...page);
    if (page.length < PAGE) break;
    const res = await zget(cfg, fetchImpl, q(start + PAGE));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    page = await res.json();
  }
  const index = new Map();
  for (const a of rows) {
    const d = a?.data;
    if (d?.contentType !== 'application/pdf' || !d.parentItem) continue;
    const name = attachmentFileName(d);
    if (!name) continue;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push({ key: a.key, parent: d.parentItem });
  }
  set(cacheKey, { version, index });
  return index;
}

async function realOf(p) {
  try { return nfc(await fs.realpath(p)); } catch { return nfc(p); }
}

async function attachmentPath(cfg, fetchImpl, key) {
  const res = await zget(cfg, fetchImpl, `items/${key}/file/view/url`);
  if (!res.ok) return null;
  try { return fileUrlToLocalPath((await res.text()).trim()); } catch { return null; }
}

async function parentMeta(cfg, fetchImpl, key) {
  const res = await zget(cfg, fetchImpl, `items/${key}?format=json`);
  if (!res.ok) return null;
  const item = await res.json();
  return item?.data ? toMeta(item.data) : null;
}

// Link rule (see plan Global Constraints). Returns null when not linked or Zotero is unreachable.
export async function findZoteroAttachment({ file, md5, doi } = {}, cfg, deps = {}) {
  const { fetchImpl = globalThis.fetch, md5File = defaultMd5File, cache } = deps;
  try {
    const index = await attachmentIndex(cfg, fetchImpl, cache);
    const mineReal = await realOf(file);
    const candidates = index.get(nfc(path.basename(file))) ?? [];
    let hit = null;
    for (const c of candidates) {
      const p = await attachmentPath(cfg, fetchImpl, c.key);
      if (p && (await realOf(p)) === mineReal) { hit = c; break; }
    }
    if (!hit && candidates.length === 0 && doi) {
      const wantDoi = String(doi).toLowerCase();
      const res = await zget(cfg, fetchImpl, `items?q=${encodeURIComponent(doi)}&qmode=everything&format=json`);
      if (res.ok) {
        const list = await res.json();
        const item = (Array.isArray(list) ? list : []).find((it) => String(it?.data?.DOI ?? '').toLowerCase() === wantDoi);
        if (item) {
          const kids = await zget(cfg, fetchImpl, `items/${item.key}/children?format=json`);
          if (kids.ok) {
            const mine = String(md5 ?? (await md5File(file))).toLowerCase();
            for (const k of ((await kids.json()) ?? [])) {
              if (k?.data?.contentType !== 'application/pdf') continue;
              const p = await attachmentPath(cfg, fetchImpl, k.key);
              if (!p) continue;
              let theirs;
              try { theirs = String(await md5File(p)).toLowerCase(); } catch { continue; }
              if (theirs === mine) { hit = { key: k.key, parent: item.key }; break; }
            }
          }
        }
      }
    }
    if (!hit) return null;
    const meta = await parentMeta(cfg, fetchImpl, hit.parent);
    return { itemKey: hit.parent, attachmentKey: hit.key, meta };
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 1)}\n`);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// Links <outputDir>/<id>/source.json to a Zotero attachment. true when linked (now or already).
export async function linkToZotero(outputDir, id, cfg, deps = {}) {
  const file = path.join(outputDir, id, 'source.json');
  let source;
  try {
    source = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return false;
  }
  if (source?.zotero?.itemKey) return true;
  const pdf = source?.pdf?.path;
  if (typeof pdf !== 'string') return false;
  const found = await findZoteroAttachment({ file: pdf, md5: source.pdf.md5, doi: source.meta?.doi }, cfg, deps);
  if (!found) return false;
  const { extractorVersion, pymupdfVersion, id: sid, meta: oldMeta, ...rest } = source;
  const next = {
    ...(extractorVersion !== undefined ? { extractorVersion } : {}),
    ...(pymupdfVersion !== undefined ? { pymupdfVersion } : {}),
    id: sid ?? id,
    zotero: { itemKey: found.itemKey, attachmentKey: found.attachmentKey },
    meta: found.meta ?? oldMeta,
    ...rest,
  };
  await writeJsonAtomic(file, next);
  return true;
}
