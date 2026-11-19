import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { validateDigest } from './validate.mjs';

async function readJson(file, label) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: `${label}이 없습니다: ${file}` };
    return { missing: `${label}을 읽지 못했습니다: ${file} (${err.message})` };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { missing: `${label} JSON 파싱 오류: ${file} (${err.message})` };
  }
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const { log = console.log, error = console.error, configPath } = opts;
  const [id] = argv;
  if (!id) {
    error('사용법: npm run check -- <id>');
    return 1;
  }
  let cfg;
  try {
    cfg = await loadConfig(configPath);
  } catch (err) {
    error(err.message);
    return 1;
  }
  const dir = path.join(cfg.outputDir, id);
  const d = await readJson(path.join(dir, 'digest.json'), 'digest.json');
  if (d.missing) {
    error(d.missing);
    return 1;
  }
  const s = await readJson(path.join(dir, 'source.json'), 'source.json');
  if (s.missing) {
    error(s.missing);
    return 1;
  }
  const { digest, problems } = validateDigest(d.value, s.value);
  if (problems.length) {
    error(`검증 문제 ${problems.length}건:`);
    for (const p of problems) error(`- ${p}`);
    return 1;
  }
  const claims = digest.cards.reduce((n, c) => n + c.items.filter((i) => i.kind === 'claim').length, 0);
  log(`검증 통과: 카드 ${digest.cards.length}개, claim ${claims}개`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exitCode = 1;
  }
}
