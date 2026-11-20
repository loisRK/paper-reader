import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MODEL_TEXT = '기본값 (계정 플랜에 따라 정해짐)';

/** A model name fit to show: a short single-line string, else null. */
export function cleanModel(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 100 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

/** Top-level `model = "..."` of a Codex config.toml (before the first [table]); no TOML dependency. */
export function parseCodexModel(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = /^model\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) return cleanModel(m[1] ?? m[2]);
  }
  return null;
}

async function readJson(readFile, file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
}

/**
 * The model each tool is configured to use, read-only from the tool's own config. Only the model field is
 * ever taken from those files. `claudeDir`: a Claude Code config dir (default ~/.claude).
 */
export async function configuredModel(id, { home = os.homedir(), env = process.env, readFile = fsp.readFile, claudeDir } = {}) {
  let model = null;
  if (id === 'claude') {
    model = cleanModel(env.ANTHROPIC_MODEL)
      ?? cleanModel((await readJson(readFile, path.join(claudeDir ?? path.join(home, '.claude'), 'settings.json')))?.model);
  } else if (id === 'codex') {
    try { model = parseCodexModel(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')); } catch { model = null; }
  }
  return model ?? DEFAULT_MODEL_TEXT;
}
