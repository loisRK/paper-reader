import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FOLDERS = 10;

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const settingsFile = (dataDir) => path.join(dataDir, 'settings.json');

export async function readSettings(dataDir) {
  try {
    const v = JSON.parse(await fs.readFile(settingsFile(dataDir), 'utf8'));
    const folders = Array.isArray(v?.folders) ? v.folders.filter((f) => typeof f === 'string') : [];
    return { folders };
  } catch {
    return { folders: [] };
  }
}

// `saved`: folders already in the settings. Only NEW paths must exist now, so an unplugged disk
// never blocks adding or removing other folders (a saved but missing folder may be kept or removed).
export async function validateFolders(folders, saved = []) {
  if (!Array.isArray(folders) || folders.some((f) => typeof f !== 'string')) {
    throw new SettingsError('folders는 경로 문자열의 배열이어야 합니다.');
  }
  if (folders.length > MAX_FOLDERS) throw new SettingsError(`폴더는 ${MAX_FOLDERS}개까지 지정할 수 있습니다.`);
  const known = new Set(saved.map((f) => path.resolve(f)));
  const out = [];
  for (const raw of folders) {
    const f = raw.trim();
    if (!path.isAbsolute(f)) throw new SettingsError('절대 경로를 입력하세요.');
    if (known.has(path.resolve(f))) {
      if (!out.includes(path.resolve(f))) out.push(path.resolve(f));
      continue;
    }
    let ok = false;
    try { ok = (await fs.stat(f)).isDirectory(); } catch { ok = false; }
    if (!ok) throw new SettingsError(`폴더를 찾을 수 없습니다: ${f}`);
    const norm = path.resolve(f);
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

export async function writeSettings(dataDir, { folders }) {
  const clean = await validateFolders(folders, (await readSettings(dataDir)).folders);
  const file = settingsFile(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ folders: clean }, null, 2));
  await fs.rename(tmp, file);
}
