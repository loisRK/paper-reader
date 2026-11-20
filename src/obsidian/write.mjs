// Writes companion notes into an Obsidian vault. Only `realpath(vault)/<folder>/*.md` is ever written;
// error messages never carry the vault's absolute path.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { mergeManaged } from './note.mjs';

export class ObsidianError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_NAME = 150;
export const MAX_NOTES = 2000;
const MAX_DIRS = 5000;

const inside = (p, root) => p === root || p.startsWith(root + path.sep);

/** Removes `/ \ : * ? " < > |`, control chars and link-breaking `# ^ [ ]`; ≤ 150 chars incl. ".md". */
export function sanitizeFileName(name) {
  let base = String(name ?? '').replace(/\.md$/i, '');
  base = base.replace(/[/\\:*?"<>|#^[\]\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  base = [...base].slice(0, MAX_NAME - 3).join('').trim();
  if (!base) throw new ObsidianError(400, '짝 노트 파일 이름을 만들 수 없습니다.');
  return `${base}.md`;
}

/** Vault-relative path → its parts. Rejects absolute paths, `.`/`..`, hidden parts (.obsidian) and empty paths. */
export function relativeParts(rel, what = '폴더') {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new ObsidianError(400, `${what} 경로가 올바르지 않습니다.`);
  const raw = rel.trim();
  if (!raw) throw new ObsidianError(400, `${what} 경로를 입력하세요.`);
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\') || raw.startsWith('~')) {
    throw new ObsidianError(400, `${what}는 vault 안의 상대 경로로 입력하세요.`);
  }
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) {
    throw new ObsidianError(400, `${what}는 vault 안의 상대 경로로 입력하세요 ('..'·숨김 폴더 불가).`);
  }
  return parts;
}

/** realpath of an existing vault directory. */
export async function resolveVault(vault) {
  if (typeof vault !== 'string' || !vault.trim()) throw new ObsidianError(400, 'Obsidian 설정에서 vault 폴더를 먼저 지정하세요.');
  if (!path.isAbsolute(vault.trim())) throw new ObsidianError(400, 'vault 폴더는 절대 경로로 입력하세요.');
  try {
    const real = await fs.realpath(vault.trim());
    if ((await fs.stat(real)).isDirectory()) return real;
  } catch { /* falls through */ }
  throw new ObsidianError(400, 'Obsidian vault 폴더를 찾을 수 없습니다. 디스크가 연결돼 있는지, 설정 경로가 맞는지 확인하세요.');
}

/**
 * Walks `parts` from the real vault one level at a time. A symlink is followed only when its target stays
 * inside the vault; nothing is created outside. create=false only checks (missing parts are fine).
 * Returns the real directory path (or null when create=false and it does not exist yet).
 */
export async function vaultDir(realVault, parts, { create }) {
  let cur = realVault;
  for (const part of parts) {
    const next = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(next);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new ObsidianError(400, '짝 노트 폴더를 확인하지 못했습니다.');
      if (!create) return null;
      try { await fs.mkdir(next); } catch (e) { if (e.code !== 'EEXIST') throw new ObsidianError(500, `짝 노트 폴더를 만들지 못했습니다 (${e.code ?? 'error'}).`); }
      st = await fs.lstat(next);
    }
    if (st.isSymbolicLink()) {
      let real;
      try { real = await fs.realpath(next); } catch { throw new ObsidianError(400, '짝 노트 폴더의 링크가 깨져 있습니다.'); }
      if (!inside(real, realVault)) throw new ObsidianError(400, 'vault 밖을 가리키는 폴더에는 쓰지 않습니다.');
      if (!(await fs.stat(real)).isDirectory()) throw new ObsidianError(400, '짝 노트 폴더 경로에 파일이 있습니다.');
      cur = real;
    } else if (st.isDirectory()) {
      cur = next;
    } else {
      throw new ObsidianError(400, '짝 노트 폴더 경로에 파일이 있습니다.');
    }
  }
  return cur;
}

// One write at a time per target file, so two sends never interleave read-merge-rename.
const queues = new Map();
function serialized(key, fn) {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/** Creates or updates `<vault>/<folder>/<fileName>`; only the managed block of an existing file changes. */
export async function writeCompanionNote({ vault, folder, fileName, managed }) {
  const realVault = await resolveVault(vault);
  const parts = relativeParts(folder, '짝 노트 폴더');
  const name = sanitizeFileName(fileName);
  const dir = await vaultDir(realVault, parts, { create: true });
  const file = path.join(dir, name);
  const relPath = [...parts, name].join('/');
  return serialized(file, async () => {
    let existing = null;
    try {
      const st = await fs.lstat(file);
      if (st.isSymbolicLink() || !st.isFile()) throw new ObsidianError(400, '짝 노트 자리에 링크나 폴더가 있어 덮어쓰지 않았습니다.');
      existing = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err instanceof ObsidianError) throw err;
      if (err.code !== 'ENOENT') throw new ObsidianError(500, `짝 노트를 읽지 못했습니다 (${err.code ?? 'error'}).`);
    }
    const merged = mergeManaged(existing, managed);
    if (merged.error) throw new ObsidianError(409, merged.error);
    const tmp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}.paper-reader.tmp`);
    try {
      await fs.writeFile(tmp, merged.text, { flag: 'wx' });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new ObsidianError(500, `짝 노트를 저장하지 못했습니다 (${err.code ?? 'error'}).`);
    }
    return { relPath };
  });
}

/** Vault-relative `.md` paths (sorted), skipping hidden entries (.obsidian, .trash) and symlinks. */
// `exclude`: a vault-relative folder (the companion-note folder) left out entirely, before the cap.
export async function listVaultNotes(vault, { max = MAX_NOTES, exclude = null } = {}) {
  const realVault = await resolveVault(vault);
  const notes = [];
  const queue = [''];
  let dirs = 0;
  let truncated = false;
  while (queue.length) {
    const rel = queue.shift();
    if (++dirs > MAX_DIRS) { truncated = true; break; }
    let entries;
    try { entries = await fs.readdir(path.join(realVault, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r !== exclude) queue.push(r); }
      else if (e.isFile() && /\.md$/i.test(e.name)) notes.push(r);
    }
  }
  notes.sort((a, b) => a.localeCompare(b));
  if (notes.length > max) { notes.length = max; truncated = true; }
  return { notes, truncated };
}

/** Reads a vault-relative note; the real path must stay inside the vault. */
export async function readVaultNote(vault, rel) {
  const realVault = await resolveVault(vault);
  const parts = relativeParts(rel, '노트');
  const dir = await vaultDir(realVault, parts.slice(0, -1), { create: false });
  if (!dir) throw new ObsidianError(400, '노트를 찾을 수 없습니다.');
  let real;
  try { real = await fs.realpath(path.join(dir, parts.at(-1))); } catch { throw new ObsidianError(400, '노트를 찾을 수 없습니다.'); }
  if (!inside(real, realVault)) throw new ObsidianError(400, 'vault 밖의 노트는 읽지 않습니다.');
  if (!(await fs.stat(real)).isFile()) throw new ObsidianError(400, '노트를 찾을 수 없습니다.');
  return fs.readFile(real, 'utf8');
}
