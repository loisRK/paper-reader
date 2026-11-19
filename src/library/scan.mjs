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

// Read-only: never modifies scanned files. Only dataDir/library-cache.json is written.
export async function scanFolders(folders, { dataDir, md5 = md5File } = {}) {
  const cacheFile = dataDir ? path.join(dataDir, 'library-cache.json') : null;
  const oldCache = cacheFile ? await readCache(cacheFile) : {};
  const newCache = {};
  const files = [];
  const problems = [];
  for (const folder of folders) {
    let rootReal;
    try {
      rootReal = await fs.realpath(folder);
      if (!(await fs.stat(rootReal)).isDirectory()) throw new Error('not dir');
    } catch {
      problems.push({ folder, message: `폴더를 찾을 수 없습니다: ${folder}` });
      continue;
    }
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
      const rel = path.relative(rootReal, full).split(path.sep).join('/');
      const c = oldCache[real];
      let hash = c && c.size === st.size && c.mtimeMs === st.mtimeMs ? c.md5 : null;
      if (!hash) {
        try { hash = await md5(real); } catch { continue; }
      }
      newCache[real] = { size: st.size, mtimeMs: st.mtimeMs, md5: hash };
      files.push({
        id: folderPaperId(rootReal, rel, path.basename(full)),
        path: real, root: rootReal, rel, size: st.size, mtimeMs: st.mtimeMs, md5: hash,
      });
    }
  }
  if (cacheFile && JSON.stringify(newCache) !== JSON.stringify(oldCache)) {
    try {
      await fs.mkdir(dataDir, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(newCache));
      await fs.rename(tmp, cacheFile);
    } catch { /* cache is best-effort */ }
  }
  return { files, problems };
}
