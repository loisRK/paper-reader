import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { resolveItem as defaultResolveItem } from '../zotero/local.mjs';
import { isSafeName } from '../reader/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'extract', 'extract_pdf.py');
const DEFAULT_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');

export const VENV_INSTALL_COMMAND = 'python3 -m venv .venv && .venv/bin/pip install -r extract/requirements.txt';

// Args are passed as an array (no shell): PDF paths may contain spaces or NFD Korean.
function defaultRunPython(python, args) {
  return new Promise((resolve) => {
    execFile(python, args, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stderr: String(stderr || (err && typeof err.code !== 'number' ? err.message : '')) });
    });
  });
}

const saveError = (err) => `추출 결과를 저장하지 못했습니다: ${String(err?.message ?? err).split('\n')[0]}`;

// Message is already user-facing (Korean); callers print it as is.
class ExtractFailure extends Error {}

async function checkPython(pythonPath) {
  try {
    await fs.access(pythonPath);
  } catch {
    throw new ExtractFailure(`Python 추출기 환경(.venv)이 없습니다. 저장소 루트에서 먼저 설치하세요:\n  ${VENV_INSTALL_COMMAND}`);
  }
}

// Shared by main() and extractFile(): run the Python extractor on pdfPath and save
// <outputDir>/<id>/source.json with { extractorVersion, pymupdfVersion, id, [zotero], meta, ...rest }.
// meta: `meta` argument (Zotero) if given, else the PDF's own (Python) meta.
async function extractAndSave({ cfg, id, pdfPath, zotero, meta, pythonPath, runPython, warn }) {
  // Figure/table images go next to source.json (fig-<page>-<n>.png; names never come from user input).
  const figuresDir = path.join(cfg.outputDir, id, 'figures');
  try {
    await fs.mkdir(figuresDir, { recursive: true });
  } catch (err) {
    throw new ExtractFailure(saveError(err));
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-reader-extract-'));
  const tmpFile = path.join(tmpDir, 'source.json');
  let extracted;
  try {
    const { code, stderr } = await runPython(pythonPath, [SCRIPT, pdfPath, tmpFile, '--figures-dir', figuresDir]);
    if (code !== 0) throw new ExtractFailure((stderr || '').trim() || `PDF 추출 실패 (exit ${code})`);
    for (const line of (stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)) warn(`경고: ${line}`);
    extracted = JSON.parse(await fs.readFile(tmpFile, 'utf8'));
  } catch (err) {
    throw err instanceof ExtractFailure ? err : new ExtractFailure(saveError(err));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const { extractorVersion, pymupdfVersion, meta: pdfMeta, ...rest } = extracted;
  const source = {
    extractorVersion,
    pymupdfVersion,
    id,
    ...(zotero ? { zotero } : {}),
    meta: meta ?? pdfMeta,
    ...rest,
  };
  const outFile = path.join(cfg.outputDir, id, 'source.json');
  try {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, `${JSON.stringify(source, null, 1)}\n`);
  } catch (err) {
    throw new ExtractFailure(saveError(err));
  }
  return { source, outFile };
}

// Extract a PDF by path, without Zotero. zoteroLink ({ itemKey, attachmentKey, meta? }) is optional.
// Throws Error with a Korean message on failure.
export async function extractFile({ cfg, file, id, zoteroLink, pythonPath = DEFAULT_PYTHON, runPython = defaultRunPython, warn = () => {} }) {
  if (!isSafeName(id)) throw new ExtractFailure(`이 항목 ID(${id})는 폴더 이름으로 쓸 수 없습니다.`);
  await checkPython(pythonPath);
  const { source } = await extractAndSave({
    cfg,
    id,
    pdfPath: file,
    zotero: zoteroLink ? { itemKey: zoteroLink.itemKey, attachmentKey: zoteroLink.attachmentKey } : undefined,
    meta: zoteroLink?.meta,
    pythonPath,
    runPython,
    warn,
  });
  return { id, source };
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const {
    resolveItem = defaultResolveItem,
    runPython = defaultRunPython,
    pythonPath = DEFAULT_PYTHON,
    log = console.log,
    error = console.error,
  } = opts;
  const [idOrKey] = argv;
  if (!idOrKey) {
    error('사용법: npm run extract -- <citekey|itemKey>');
    return 1;
  }
  try {
    await checkPython(pythonPath);
  } catch (err) {
    error(err.message);
    return 1;
  }
  let cfg = opts.cfg;
  if (!cfg) {
    try {
      cfg = await loadConfig(opts.configPath);
    } catch (err) {
      error(`설정 파일을 읽지 못했습니다: ${err.message}`);
      return 1;
    }
  }

  let item;
  try {
    item = await resolveItem(idOrKey, cfg, opts);
  } catch (err) {
    error(err.message);
    return 1;
  }
  if (!isSafeName(item.id)) {
    error(`이 항목 ID(${item.id})는 폴더 이름으로 쓸 수 없습니다. Zotero 항목 key로 다시 실행하세요.`);
    return 1;
  }

  let result;
  try {
    result = await extractAndSave({
      cfg,
      id: item.id,
      pdfPath: item.pdfPath,
      zotero: { itemKey: item.itemKey, attachmentKey: item.attachmentKey },
      meta: item.meta,
      pythonPath,
      runPython,
      warn: error,
    });
  } catch (err) {
    error(err instanceof ExtractFailure ? err.message : saveError(err));
    return 1;
  }
  const { source, outFile } = result;

  const nImages = (source.figures ?? []).filter((f) => f.image).length;
  const nSentences = Object.keys(source.sentences ?? {}).length;
  log(`저장: ${outFile}`);
  log(`문장 ${nSentences}개 · 페이지 ${(source.pages ?? []).length}쪽 · 그림·표 ${(source.figures ?? []).length}개 (이미지 ${nImages}개)`);
  log(`이제 AI 도구에게 'prompts/digest.md 규칙으로 ${item.id} 요약을 써줘'라고 요청하세요.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(saveError(err));
    process.exitCode = 1;
  }
}
