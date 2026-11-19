import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FOLDERS = 10;
export const AGENT_IDS = ['claude', 'codex', 'gemini'];

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const settingsFile = (dataDir) => path.join(dataDir, 'settings.json');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// lastModels: { <key>: { model, at } } — the model a tool last reported when it ran.
function cleanLastModels(v) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const [k, e] of Object.entries(v)) {
    if (isObj(e) && typeof e.model === 'string' && typeof e.at === 'string') out[k] = { model: e.model, at: e.at };
  }
  return Object.keys(out).length ? out : undefined;
}

// agentProfile: { claude: '<account label>' } — which account (config dir) of a tool to run.
const PROFILE_AGENTS = ['claude'];
const LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function cleanProfiles(v) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const a of PROFILE_AGENTS) if (typeof v[a] === 'string' && LABEL_RE.test(v[a])) out[a] = v[a];
  return Object.keys(out).length ? out : undefined;
}

export async function readSettings(dataDir) {
  try {
    const v = JSON.parse(await fs.readFile(settingsFile(dataDir), 'utf8'));
    const folders = Array.isArray(v?.folders) ? v.folders.filter((f) => typeof f === 'string') : [];
    const out = { folders };
    if (AGENT_IDS.includes(v?.agent)) out.agent = v.agent;
    const agentProfile = cleanProfiles(v?.agentProfile);
    if (agentProfile) out.agentProfile = agentProfile;
    const lastModels = cleanLastModels(v?.lastModels);
    if (lastModels) out.lastModels = lastModels;
    return out;
  } catch {
    return { folders: [] };
  }
}

async function writeAtomic(dataDir, next) {
  const file = settingsFile(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, file);
}

export async function recordLastModel(dataDir, key, model, at = new Date().toISOString()) {
  const saved = await readSettings(dataDir);
  saved.lastModels = { ...(saved.lastModels ?? {}), [key]: { model: String(model).slice(0, 100), at } };
  await writeAtomic(dataDir, saved);
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

// Fields left undefined keep their saved value, so saving folders never drops `agent` and vice versa.
export async function writeSettings(dataDir, { folders, agent, agentProfile } = {}) {
  const saved = await readSettings(dataDir);
  const next = { folders: folders === undefined ? saved.folders : await validateFolders(folders, saved.folders) };
  if (agent !== undefined) {
    if (!AGENT_IDS.includes(agent)) throw new SettingsError('알 수 없는 AI 도구입니다.');
    next.agent = agent;
  } else if (saved.agent) next.agent = saved.agent;
  if (agentProfile !== undefined) {
    if (!isObj(agentProfile) || Object.entries(agentProfile).some(([k, v]) => !PROFILE_AGENTS.includes(k) || typeof v !== 'string' || !LABEL_RE.test(v))) {
      throw new SettingsError('알 수 없는 계정입니다.');
    }
    next.agentProfile = { ...(saved.agentProfile ?? {}), ...agentProfile };
  } else if (saved.agentProfile) next.agentProfile = saved.agentProfile;
  if (saved.lastModels) next.lastModels = saved.lastModels;
  await writeAtomic(dataDir, next);
}
