import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { zoteroRunning, registerPaper, NOT_RUNNING_MESSAGE } from './local.mjs';

export async function main(argv = process.argv.slice(2), opts = {}) {
  const [fileArg, ...nums] = argv;
  if (!fileArg || nums.length === 0) {
    console.error('사용법: npm run register -- <검색파일명> <번호...>');
    return 1;
  }
  const cfg = opts.cfg ?? await loadConfig();
  const name = fileArg.endsWith('.json') ? fileArg : `${fileArg}.json`;
  let search;
  try {
    search = JSON.parse(await fs.readFile(path.join(cfg.outputDir, '_search', path.basename(name)), 'utf8'));
  } catch (err) {
    console.error(`검색 파일을 읽을 수 없습니다: ${name} (${err.message})`);
    return 1;
  }
  if (!(await zoteroRunning(cfg, opts))) {
    console.error(NOT_RUNNING_MESSAGE);
    return 1;
  }
  let failed = false;
  for (const raw of nums) {
    const n = Number(raw);
    const paper = search.papers.find((p) => p.n === n);
    if (!paper) {
      console.log(`${raw}번 논문이 이 검색 결과에 없습니다.`);
      failed = true;
      continue;
    }
    const r = await registerPaper(paper, cfg, opts);
    console.log(`${r.ok ? 'OK' : '실패'} [${n}] ${paper.title} — ${r.message}`);
    if (!r.ok) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main();
}
