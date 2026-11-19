import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULTS = {
  outputDir: './digests',
  dataDir: './data',
  zotero: { baseUrl: 'http://127.0.0.1:23119', authFile: './data/zotero-auth.json' },
  reader: { port: 5173 },
  search: {
    monthsBack: 24,
    emergingWindowMonths: 6,
    perTrend: 5,
    topJournals: 5,
    maxResults: 600,
    openalexApiKey: null,
    contactEmail: null,
    // LNCS, LNCS online, CEUR-WS, Procedia Computer Science, CCIS (conference proceedings series)
    excludedIssns: ['0302-9743', '1611-3349', '1613-0073', '1877-0509', '1865-0929'],
  },
  metrics: { sjrCsv: './data/scimagojr.csv', mjlCsv: null },
  researchContextFile: null,
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep merge: objects recurse, arrays and scalars are replaced.
function merge(base, override) {
  const out = {};
  for (const key of Object.keys(base)) {
    out[key] = isPlainObject(base[key]) ? merge(base[key], {}) : structuredClone(base[key]);
  }
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : structuredClone(value);
  }
  return out;
}

export async function loadConfig(configPath = './paper-reader.config.json') {
  const file = path.resolve(configPath);
  const baseDir = path.dirname(file);

  let user = {};
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${file}을(를) 읽을 수 없습니다 (${err.message})`);
  }
  if (raw !== undefined) {
    try {
      user = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${file}의 JSON 형식이 올바르지 않습니다 (${err.message})`);
    }
    if (!isPlainObject(user)) throw new Error(`${file}의 최상위 값은 객체여야 합니다`);
  }

  const config = merge(DEFAULTS, user);
  const abs = (p) => (typeof p === 'string' ? path.resolve(baseDir, p) : p);
  config.outputDir = abs(config.outputDir);
  config.dataDir = abs(config.dataDir);
  config.metrics.sjrCsv = abs(config.metrics.sjrCsv);
  config.metrics.mjlCsv = abs(config.metrics.mjlCsv);
  config.zotero.authFile = abs(config.zotero.authFile);
  config.researchContextFile = abs(config.researchContextFile);
  return config;
}
