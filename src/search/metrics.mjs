import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeIssn } from './verify.mjs';

const SJR_URL = 'https://www.scimagojr.com/journalrank.php?out=xls';

// Minimal CSV parser: quoted fields, doubled quotes, delimiters/newlines inside quotes.
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (d) => header.split(d).length;
  return count(';') > count(',') ? ';' : ',';
}

async function readTable(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  text = text.replace(/^﻿/, '');
  const rows = parseCsv(text, detectDelimiter(text));
  if (rows.length === 0) return null;
  const header = rows[0].map((h) => h.trim());
  return { header, rows: rows.slice(1) };
}

// Hyphen-insensitive key; only well-formed 8-char ISSNs are indexed.
const issnKey = (v) => {
  const s = normalizeIssn(v).replace('-', '');
  return /^[0-9]{7}[0-9X]$/.test(s) ? s : null;
};

function splitIssns(value) {
  return String(value ?? '').split(/[,;\s]+/).map(issnKey).filter(Boolean);
}

export async function loadMetrics(cfg) {
  const index = { sjr: new Map(), mjl: new Map() };
  const m = cfg?.metrics ?? {};

  if (m.sjrCsv) {
    const t = await readTable(m.sjrCsv);
    if (t) {
      const col = (name) => t.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
      const iIssn = col('Issn');
      const iQ = col('SJR Best Quartile');
      const fromName = /scimagojr[-_ ]?(\d{4})/i.exec(path.basename(m.sjrCsv));
      const year = m.sjrYear ?? (fromName ? Number(fromName[1]) : null);
      if (iIssn >= 0) {
        for (const r of t.rows) {
          const q = /^Q[1-4]$/.exec((r[iQ] ?? '').trim());
          const entry = { sjrQuartile: q ? q[0] : null, sjrYear: year };
          for (const k of splitIssns(r[iIssn])) index.sjr.set(k, entry);
        }
      }
    }
  }

  if (m.mjlCsv) {
    const t = await readTable(m.mjlCsv);
    if (t) {
      const lower = t.header.map((h) => h.toLowerCase());
      const iIssn = lower.indexOf('issn');
      const iE = lower.indexOf('eissn');
      const cols = lower.map((h, i) => (/collection|index/.test(h) ? i : -1)).filter((i) => i >= 0);
      for (const r of t.rows) {
        const idxText = cols.map((i) => r[i] ?? '').join(' | ');
        const entry = {
          scie: /Science Citation Index Expanded/i.test(idxText),
          ssci: /Social Sciences Citation Index/i.test(idxText),
        };
        for (const k of [r[iIssn], r[iE]].map(issnKey).filter(Boolean)) {
          const prev = index.mjl.get(k);
          index.mjl.set(k, prev ? { scie: prev.scie || entry.scie, ssci: prev.ssci || entry.ssci } : entry);
        }
      }
    }
  }
  return index;
}

export function lookupMetrics(index, issns) {
  const out = { scopus: null, sjrQuartile: null, sjrYear: null, wos: null, scie: null, ssci: null };
  for (const k of (issns ?? []).map(issnKey).filter(Boolean)) {
    const s = index?.sjr?.get(k);
    if (s) {
      out.scopus = true;
      out.sjrQuartile ??= s.sjrQuartile;
      out.sjrYear ??= s.sjrYear;
    }
    const w = index?.mjl?.get(k);
    if (w) {
      out.wos = true;
      if (w.scie) out.scie = true;
      if (w.ssci) out.ssci = true;
    }
  }
  return out;
}

export async function downloadSjr({ fetchImpl = globalThis.fetch, dir = './data', year = new Date().getFullYear() - 1 } = {}) {
  let res;
  try {
    res = await fetchImpl(SJR_URL);
  } catch (err) {
    throw new Error(`SCImago 다운로드 실패. 네트워크 연결을 확인하세요 (${new URL(SJR_URL).host})`, { cause: err });
  }
  if (!res.ok) throw new Error(`SCImago 다운로드 실패: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const header = body.subarray(0, 4096).toString('utf8').split(/\r?\n/, 1)[0];
  if (!/\bIssn\b/i.test(header)) {
    throw new Error('SJR 파일 형식이 아닙니다(웹페이지가 내려왔을 수 있음). 브라우저에서 직접 받아 data/에 넣으세요.');
  }
  await fs.mkdir(dir, { recursive: true });
  const file = path.resolve(dir, `scimagojr-${year}.csv`);
  await fs.writeFile(file, body);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--download')) {
    try {
      const file = await downloadSjr();
      console.log(`저장됨: ${file}\n설정(paper-reader.config.json)에 추가:\n  "metrics": { "sjrCsv": "${file}" }`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  } else {
    console.log('사용법: node src/search/metrics.mjs --download');
  }
}
