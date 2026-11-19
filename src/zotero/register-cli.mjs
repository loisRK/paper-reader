import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { zoteroRunning, registerPaper, NOT_RUNNING_MESSAGE } from './local.mjs';

export async function main(argv = process.argv.slice(2), opts = {}) {
  const { log = console.log, error = console.error } = opts;
  const [fileArg, ...nums] = argv;
  if (!fileArg || nums.length === 0) {
    error('사용법: npm run register -- <검색파일명> <번호...>');
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
  const name = fileArg.endsWith('.json') ? fileArg : `${fileArg}.json`;
  let search;
  try {
    search = JSON.parse(await fs.readFile(path.join(cfg.outputDir, '_search', path.basename(name)), 'utf8'));
  } catch (err) {
    error(`검색 파일을 읽을 수 없습니다: ${name} (${err.message})`);
    return 1;
  }
  if (!Array.isArray(search?.papers)) {
    error(`검색 결과 파일 형식이 올바르지 않습니다: ${name}`);
    return 1;
  }
  if (!(await zoteroRunning(cfg, opts))) {
    error(NOT_RUNNING_MESSAGE);
    return 1;
  }
  let failed = false;
  for (const raw of nums) {
    const n = Number(raw);
    const paper = search.papers.find((p) => p?.n === n);
    if (!paper) {
      log(`${raw}번 논문이 이 검색 결과에 없습니다.`);
      failed = true;
      continue;
    }
    const r = await registerPaper(paper, cfg, opts);
    log(`${r.ok ? 'OK' : '실패'} [${n}] ${paper.title} — ${r.message}`);
    if (!r.ok) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`등록 중 오류가 발생했습니다: ${String(err?.message ?? err).split('\n')[0]}`);
    process.exitCode = 1;
  }
}
