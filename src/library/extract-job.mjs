import { readSettings } from './settings.mjs';
import { scanFolders } from './scan.mjs';

// Upper bound for the post-extract Zotero link step (each Zotero call has its own 10 s timeout too).
export const LINK_TIMEOUT_MS = 30_000;
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
  linkTimeoutMs = LINK_TIMEOUT_MS,
  // (folders) => { files }. The server passes its non-blocking library list (no MD5 wait).
  listFiles = (folders) => scanFolders(folders, { dataDir, md5 }),
  // (file) => Promise<{ id, state } | null>: an existing bundle of the same PDF (MD5 or realpath).
  findDuplicate = async () => null,
}) {
  let busy = false;
  return async function runExtract(id) {
    if (busy) throw new JobError(409, BUSY_MESSAGE);
    busy = true;
    try {
      const { folders } = dataDir ? await readSettings(dataDir) : { folders: [] };
      const { files } = folders.length ? await listFiles(folders) : { files: [] };
      const found = files.find((f) => f.id === id);
      if (!found) throw new JobError(404, NOT_FOUND_MESSAGE);
      // Same PDF already extracted (e.g. a copy of a Zotero paper): never create a duplicate bundle.
      let dup = null;
      try { dup = await findDuplicate(found); } catch { /* unreadable: extraction reports it */ }
      if (dup) return { id: dup.id, state: dup.state, merged: true };
      try {
        await extractFile({ cfg, file: found.path, id });
      } catch (err) {
        throw new JobError(500, String(err?.message ?? err).split('\n')[0] || '추출에 실패했습니다.');
      }
      // Best effort and bounded: a hung Zotero must never keep `busy` set. Retried on a later list.
      let timer;
      try {
        await Promise.race([
          linkToZotero(cfg.outputDir, id, cfg, linkDeps),
          new Promise((resolve) => { timer = setTimeout(resolve, linkTimeoutMs); }),
        ]);
      } catch { /* quiet */ } finally {
        clearTimeout(timer);
      }
      return { id, state: 'extracted' };
    } finally {
      busy = false;
    }
  };
}
