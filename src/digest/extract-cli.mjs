import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { resolveItem as defaultResolveItem } from '../zotero/local.mjs';

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
    await fs.access(pythonPath);
  } catch {
    error(`Python 추출기 환경(.venv)이 없습니다. 저장소 루트에서 먼저 설치하세요:\n  ${VENV_INSTALL_COMMAND}`);
    return 1;
  }
  const cfg = opts.cfg ?? await loadConfig();

  let item;
  try {
    item = await resolveItem(idOrKey, cfg, opts);
  } catch (err) {
    error(err.message);
    return 1;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-reader-extract-'));
  const tmpFile = path.join(tmpDir, 'source.json');
  let extracted;
  try {
    const { code, stderr } = await runPython(pythonPath, [SCRIPT, item.pdfPath, tmpFile]);
    if (code !== 0) {
      error((stderr || '').trim() || `PDF 추출 실패 (exit ${code})`);
      return 1;
    }
    extracted = JSON.parse(await fs.readFile(tmpFile, 'utf8'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const { extractorVersion, ...rest } = extracted;
  const source = {
    extractorVersion,
    id: item.id,
    zotero: { itemKey: item.itemKey, attachmentKey: item.attachmentKey },
    meta: item.meta,
    ...rest,
  };
  const outDir = path.join(cfg.outputDir, item.id);
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'source.json');
  await fs.writeFile(outFile, `${JSON.stringify(source, null, 1)}\n`);

  const nSentences = Object.keys(source.sentences ?? {}).length;
  log(`저장: ${outFile}`);
  log(`문장 ${nSentences}개 · 페이지 ${(source.pages ?? []).length}쪽 · 그림·표 ${(source.figures ?? []).length}개`);
  log(`이제 AI 도구에게 'prompts/digest.md 규칙으로 ${item.id} 요약을 써줘'라고 요청하세요.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main();
}
