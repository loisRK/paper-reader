// Claude Code accounts = config dirs. The default account uses ~/.claude (+ ~/.claude.json); shell aliases like
// `alias claude-yvin='CLAUDE_CONFIG_DIR=~/.claude/yvin claude'` add more. Everything here only reads.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuredModel } from './models.mjs';

export const DEFAULT_PROFILE = 'claude';
export const NO_LOGIN_TEXT = '로그인 정보 없음';
export const PROFILE_LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const RC_FILES = ['.zshrc', '.bashrc', '.zprofile'];

function expandDir(raw, home) {
  let d = raw.trim();
  if (/^(['"]).*\1$/.test(d)) d = d.slice(1, -1);
  if (d === '~' || d.startsWith('~/')) d = path.join(home, d.slice(1));
  else if (/^\$\{?HOME\}?(\/|$)/.test(d)) d = path.join(home, d.replace(/^\$\{?HOME\}?/, ''));
  if (d.includes('$') || !path.isAbsolute(d)) return null;
  return path.resolve(d);
}

/** `alias <name>='[export ]CLAUDE_CONFIG_DIR=<dir> claude …'` (single or double quoted) -> [{ label, dir }]. */
export function parseClaudeAliases(text, home) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const a = /^\s*alias\s+([A-Za-z0-9_.-]+)=(['"])(.*)\2\s*(?:#.*)?$/.exec(line);
    if (!a) continue;
    const [, label, , body] = a;
    const m = /^\s*(?:export\s+)?CLAUDE_CONFIG_DIR=("[^"]*"|'[^']*'|\S+)\s+(?:command\s+)?claude(?:\s.*)?$/.exec(body);
    if (!m || label === DEFAULT_PROFILE || !PROFILE_LABEL_RE.test(label)) continue;
    const dir = expandDir(m[1], home);
    if (dir) out.push({ label, dir });
  }
  return out;
}

/** [{ label, dir }] with the default account first (dir null = no CLAUDE_CONFIG_DIR). Alias dirs must exist. */
export async function claudeProfiles({ home = os.homedir(), readFile = fsp.readFile, stat = fsp.stat } = {}) {
  const profiles = [{ label: DEFAULT_PROFILE, dir: null }];
  const seenDirs = new Set([path.resolve(home, '.claude')]);
  const seenLabels = new Set([DEFAULT_PROFILE]);
  for (const rc of RC_FILES) {
    let text;
    try { text = await readFile(path.join(home, rc), 'utf8'); } catch { continue; }
    for (const p of parseClaudeAliases(text, home)) {
      if (seenDirs.has(p.dir) || seenLabels.has(p.label)) continue;
      try { if (!(await stat(p.dir)).isDirectory()) continue; } catch { continue; }
      seenDirs.add(p.dir);
      seenLabels.add(p.label);
      profiles.push(p);
    }
  }
  return profiles;
}

async function signedInEmail(file, readFile) {
  try {
    const e = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount?.emailAddress;
    return typeof e === 'string' && e.length <= 200 && e.includes('@') && !/\s/.test(e) ? e : null;
  } catch { return null; }
}

export const lastModelKey = (agent, profile) => (agent === 'claude' ? `claude:${profile ?? DEFAULT_PROFILE}` : agent);

/** What the UI may see about one account: no paths. */
export async function profileView({ label, dir }, { home = os.homedir(), env = process.env, readFile = fsp.readFile, lastModels = {} } = {}) {
  const accountFile = dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
  return {
    label,
    email: (await signedInEmail(accountFile, readFile)) ?? NO_LOGIN_TEXT,
    configuredModel: await configuredModel('claude', { home, env, readFile, claudeDir: dir ?? undefined }),
    lastModel: lastModels[lastModelKey('claude', label)] ?? null,
  };
}
