import { readSettings } from './settings.mjs';
import { scanFolders } from './scan.mjs';
import { extractFile as defaultExtractFile } from '../digest/extract-cli.mjs';

export class JobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const BUSY_MESSAGE = '다른 논문을 추출하고 있습니다. 끝난 뒤 다시 시도하세요.';
export const NOT_FOUND_MESSAGE = '폴더에서 이 PDF를 찾을 수 없습니다.';

// One extraction at a time. runExtract(id) => { id, state }; throws JobError(404|409|500).
// linkToZotero(outputDir, id, cfg, deps) is injected (Task 3); the default does nothing.
export function createExtractJob({
  cfg,
  dataDir,
  md5,
  extractFile = defaultExtractFile,
  linkToZotero = async () => false,
  linkDeps = {},
}) {
  let busy = false;
  return async function runExtract(id) {
    if (busy) throw new JobError(409, BUSY_MESSAGE);
    busy = true;
    try {
      const { folders } = dataDir ? await readSettings(dataDir) : { folders: [] };
      const { files } = folders.length ? await scanFolders(folders, { dataDir, md5 }) : { files: [] };
      const found = files.find((f) => f.id === id);
      if (!found) throw new JobError(404, NOT_FOUND_MESSAGE);
      try {
        await extractFile({ cfg, file: found.path, id });
      } catch (err) {
        throw new JobError(500, String(err?.message ?? err).split('\n')[0] || '추출에 실패했습니다.');
      }
      try {
        await linkToZotero(cfg.outputDir, id, cfg, linkDeps);
      } catch { /* linking is best effort; it is retried on a later scan */ }
      return { id, state: 'extracted' };
    } finally {
      busy = false;
    }
  };
}
