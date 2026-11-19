import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Bundled public examples (CC BY papers). Listed alongside own papers with `example: true`;
// their reading progress is stored under outputDir so the repository stays untouched.
export const EXAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples');

// One name rule for paper ids and search names (folder/file names): letters (incl. Korean), digits, _ . -
export const NAME_RE = /^[\p{L}\p{N}_.\-]+$/u;
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

async function bundleIds(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && isSafeName(e.name)).map((e) => e.name);
}

export async function listPaperBundles(outputDir, { examplesDir = EXAMPLES_DIR } = {}) {
  const ids = new Set([...(await bundleIds(outputDir)), ...(await bundleIds(examplesDir))]);
  const out = [];
  for (const id of ids) {
    const bundle = await readPaper(outputDir, id, { examplesDir });
    if (bundle) out.push(bundle);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Own papers in outputDir take precedence over an example with the same id.
// Returns null when the paper (source.json) does not exist or is unreadable in either place.
// True when any sentence lacks PDF-coordinate rects (needs `npm run extract` again for Zotero sync).
export function needsReextract(source) {
  const sentences = Object.values(source?.sentences ?? {});
  return sentences.some((s) => !Array.isArray(s?.pdfRects) || !s.pdfRects.length);
}

export async function readPaper(outputDir, id, { examplesDir = EXAMPLES_DIR } = {}) {
  let dir = path.join(outputDir, id);
  let example = false;
  let src = await readOptional(path.join(dir, 'source.json'));
  if (src.missing && examplesDir) {
    dir = path.join(examplesDir, id);
    example = true;
    src = await readOptional(path.join(dir, 'source.json'));
  }
  if (src.value === undefined) return null;
  const dig = await readOptional(path.join(dir, 'digest.json'));
  const prog = await readOptional(path.join(outputDir, id, 'progress.json'));
  return {
    id,
    example,
    source: src.value,
    rawDigest: dig.value ?? null,
    digestError: dig.error ?? null,
    progress: prog.value ?? { ...DEFAULT_PROGRESS },
    needsReextract: needsReextract(src.value),
  };
}

export async function writeProgress(outputDir, id, progress) {
  const dir = path.join(outputDir, id);
  const file = path.join(dir, 'progress.json');
  await fs.mkdir(dir, { recursive: true });
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
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isSafeName).sort().reverse();
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
