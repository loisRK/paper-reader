import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { NAME_RE } from '../reader/store.mjs';

export const MAX_DEPTH = 8;
export const MAX_PDFS_PER_FOLDER = 5000;

export function folderPaperId(rootReal, relPath, fileName) {
  const stem = fileName.normalize('NFC').replace(/\.pdf$/i, '');
  let name = '';
  for (const ch of stem.replace(/\s/g, '_')) if (NAME_RE.test(ch)) name += ch;
  name = Array.from(name).slice(0, 60).join('') || 'paper';
  const hash = crypto.createHash('sha1').update(`${rootReal}\0${relPath}`).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

export function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function readCache(file) {
  try {
    const v = JSON.parse(await fs.readFile(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function walk(rootReal, dir, depth, acc, state) {
  if (depth > MAX_DEPTH || state.truncated) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (state.truncated) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      await walk(rootReal, full, depth + 1, acc, state);
    } else if (e.isFile() && /\.pdf$/i.test(e.name)) {
      if (acc.length >= MAX_PDFS_PER_FOLDER) { state.truncated = true; return; }
      acc.push(full);
    }
  }
}

async function writeCache(dataDir, cacheFile, cache) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache));
    await fs.rename(tmp, cacheFile);
  } catch { /* cache is best-effort */ }
}

// Folder library with a non-blocking MD5 worker.
// list(folders) only walks and stats (readdir/stat/realpath) and returns at once; files whose MD5 is not
// cached yet come back with md5: null and are queued. One worker hashes the queue one file at a time;
// concurrent list() calls only add to the same queue, so no file is hashed twice. The cache
// (dataDir/library-cache.json, { [realpath]: { size, mtimeMs, md5, folder } }) is persisted as it goes.
// Entries are pruned only when their folder is no longer configured, or when their folder was scanned
// and the file is gone; entries of a temporarily missing folder (unplugged disk) are kept.
// Read-only: never modifies scanned files.
export function createLibrary({ dataDir, md5 = md5File, persistMs = 1000 } = {}) {
  const cacheFile = dataDir ? path.join(dataDir, 'library-cache.json') : null;
  let cachePromise = null;
  const loadCache = () => (cachePromise ??= cacheFile ? readCache(cacheFile) : Promise.resolve({}));
  const queue = new Map(); // realpath -> { size, mtimeMs, folder }
  const failed = new Map(); // realpath -> `${size}:${mtimeMs}` (unreadable; not retried until it changes)
  let current = null;
  let worker = null;
  let lastPersist = 0;
  let dirty = false;

  async function persist(force) {
    if (!cacheFile || !dirty) return;
    if (!force && Date.now() - lastPersist < persistMs) return;
    dirty = false;
    lastPersist = Date.now();
    await writeCache(dataDir, cacheFile, await loadCache());
  }

  function kick() {
    if (worker || !queue.size) return;
    worker = (async () => {
      const cache = await loadCache();
      while (queue.size) {
        const [real, st] = queue.entries().next().value;
        queue.delete(real);
        current = real;
        try {
          const hash = await md5(real);
          cache[real] = { size: st.size, mtimeMs: st.mtimeMs, md5: hash, folder: st.folder };
          dirty = true;
        } catch {
          failed.set(real, `${st.size}:${st.mtimeMs}`);
        }
        current = null;
        await persist(false);
      }
      await persist(true);
    })().finally(() => {
      worker = null;
      kick();
    });
  }

  const fresh = (c, st) => c && c.size === st.size && c.mtimeMs === st.mtimeMs && typeof c.md5 === 'string';

  async function list(folders) {
    const cache = await loadCache();
    const files = [];
    const problems = [];
    const seen = new Set();
    const scannedOk = new Set();
    for (const folder of folders) {
      let rootReal;
      try {
        rootReal = await fs.realpath(folder);
        if (!(await fs.stat(rootReal)).isDirectory()) throw new Error('not dir');
      } catch {
        problems.push({ folder, message: `폴더를 찾을 수 없습니다: ${folder}` });
        continue;
      }
      scannedOk.add(folder);
      const found = [];
      const state = { truncated: false };
      await walk(rootReal, rootReal, 0, found, state);
      if (state.truncated) {
        problems.push({ folder, message: `PDF가 ${MAX_PDFS_PER_FOLDER}개를 넘어 앞의 ${MAX_PDFS_PER_FOLDER}개만 표시합니다.` });
      }
      for (const full of found) {
        let real, st;
        try {
          real = await fs.realpath(full);
          st = await fs.stat(real);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        seen.add(real);
        const rel = path.relative(rootReal, full).split(path.sep).join('/');
        const c = cache[real];
        let hash = null;
        if (fresh(c, st)) {
          hash = c.md5;
          if (c.folder !== folder && !folders.includes(c.folder)) { c.folder = folder; dirty = true; }
        } else if (failed.get(real) !== `${st.size}:${st.mtimeMs}` && current !== real && !queue.has(real)) {
          queue.set(real, { size: st.size, mtimeMs: st.mtimeMs, folder });
        }
        files.push({
          id: folderPaperId(rootReal, rel, path.basename(full)),
          path: real, root: rootReal, folder, rel, size: st.size, mtimeMs: st.mtimeMs, md5: hash,
        });
      }
    }
    for (const [real, c] of Object.entries(cache)) {
      const gone = c?.folder ? !folders.includes(c.folder) || (scannedOk.has(c.folder) && !seen.has(real)) : !seen.has(real);
      if (gone && current !== real && !queue.has(real)) { delete cache[real]; dirty = true; }
    }
    await persist(true);
    kick();
    const done = files.filter((f) => f.md5 || failed.has(f.path)).length;
    return { files, problems, hashing: { done, total: files.length } };
  }

  // Hashes one listed file now (cache hit if still fresh) and stores it in the cache. Throws if unreadable.
  async function hashNow(file) {
    const cache = await loadCache();
    const st = await fs.stat(file.path);
    const c = cache[file.path];
    if (fresh(c, st)) return c.md5;
    const hash = await md5(file.path);
    cache[file.path] = { size: st.size, mtimeMs: st.mtimeMs, md5: hash, folder: file.folder ?? c?.folder ?? null };
    queue.delete(file.path);
    failed.delete(file.path);
    dirty = true;
    await persist(true);
    return hash;
  }

  // Resolves when the queue is empty and the cache is written.
  async function idle() {
    while (worker) await worker;
  }

  return { list, idle, hashNow };
}

// Blocking variant (CLI/tests): lists, waits for every MD5, then lists again from the cache.
export async function scanFolders(folders, { dataDir, md5 = md5File } = {}) {
  const lib = createLibrary({ dataDir, md5 });
  await lib.list(folders);
  await lib.idle();
  const { files, problems } = await lib.list(folders);
  return { files, problems };
}
