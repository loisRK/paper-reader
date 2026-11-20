// Validates the "Obsidian" settings: { vault, folder, summaryFolder, researchNote }. Stored via library/settings.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveVault, relativeParts, vaultDir, ObsidianError } from './write.mjs';

export const DEFAULT_FOLDER = 'Papers';
export const DEFAULT_SUMMARY_FOLDER = 'Summaries';
const blank = (v) => v === undefined || v === null || v === '';

/**
 * vault: existing directory (absolute). folder / summaryFolder: vault-relative (may not exist yet, must not leave the vault).
 * researchNote: vault-relative existing .md inside the vault, or null.
 */
export async function validateObsidianSettings({ vault, folder, summaryFolder, researchNote } = {}) {
  const realVault = await resolveVault(vault);
  const folderParts = relativeParts(blank(folder) ? DEFAULT_FOLDER : folder, '논문 노트 폴더');
  await vaultDir(realVault, folderParts, { create: false });
  const summaryParts = relativeParts(blank(summaryFolder) ? DEFAULT_SUMMARY_FOLDER : summaryFolder, '요약 노트 폴더');
  await vaultDir(realVault, summaryParts, { create: false });
  let note = null;
  if (researchNote !== undefined && researchNote !== null && researchNote !== '') {
    const parts = relativeParts(researchNote, '연구 주제 노트');
    if (!/\.md$/i.test(parts.at(-1))) throw new ObsidianError(400, '연구 주제 노트는 .md 파일이어야 합니다.');
    const dir = await vaultDir(realVault, parts.slice(0, -1), { create: false });
    let ok = false;
    if (dir) {
      try {
        const real = await fs.realpath(path.join(dir, parts.at(-1)));
        ok = (real === realVault || real.startsWith(realVault + path.sep)) && (await fs.stat(real)).isFile();
      } catch { ok = false; }
    }
    if (!ok) throw new ObsidianError(400, '연구 주제 노트를 vault 안에서 찾을 수 없습니다.');
    note = parts.join('/');
  }
  return { vault: path.resolve(vault.trim()), folder: folderParts.join('/'), summaryFolder: summaryParts.join('/'), researchNote: note };
}
