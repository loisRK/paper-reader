import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const NAME_RE = /^[\w.\-]+$/;
export const isSafeName = (s) => typeof s === 'string' && NAME_RE.test(s) && s !== '.' && s !== '..';

export const DEFAULT_PROGRESS = { read: [], mode: '10min', focus: false };

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptional(file) {
  try {
    return { value: await readJsonFile(file) };
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { error: err.message };
  }
}

export async function listPaperBundles(outputDir) {
  let entries;
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || !isSafeName(e.name)) continue;
    const bundle = await readPaper(outputDir, e.name);
    if (bundle) out.push(bundle);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Returns null when the paper (source.json) does not exist or is unreadable.
export async function readPaper(outputDir, id) {
  const src = await readOptional(path.join(outputDir, id, 'source.json'));
  if (src.value === undefined) return null;
  const dig = await readOptional(path.join(outputDir, id, 'digest.json'));
  const prog = await readOptional(path.join(outputDir, id, 'progress.json'));
  return {
    id,
    source: src.value,
    rawDigest: dig.value ?? null,
    digestError: dig.error ?? null,
    progress: prog.value ?? { ...DEFAULT_PROGRESS },
  };
}

export async function writeProgress(outputDir, id, progress) {
  const dir = path.join(outputDir, id);
  const file = path.join(dir, 'progress.json');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(progress, null, 2));
  await fs.rename(tmp, file);
}

export async function listSearches(outputDir) {
  let names;
  try {
    names = await fs.readdir(path.join(outputDir, '_search'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort().reverse();
}

// Returns null when the search file does not exist.
export async function readSearch(outputDir, name) {
  try {
    return await readJsonFile(path.join(outputDir, '_search', `${name}.json`));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
