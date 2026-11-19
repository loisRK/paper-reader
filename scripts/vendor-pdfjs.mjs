// pdfjs-dist 를 npm 레지스트리에서 받아 src/reader/public/vendor/pdfjs/ 에 넣는다.
// 버전과 무결성(sha512)은 여기에 고정한다. 같은 VERSION 이 이미 있으면 아무것도 하지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const PDFJS_VERSION = '6.5.438';
export const TARBALL = `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${PDFJS_VERSION}.tgz`;
export const INTEGRITY = 'sha512-vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==';

const DEST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'reader', 'public', 'vendor', 'pdfjs');

// tarball 안 경로(package/ 제외) → 넣을 상대 경로. 접두어 규칙은 '/'로 끝난다.
const FILES = new Map([
  ['build/pdf.min.mjs', 'pdf.min.mjs'],
  ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['web/pdf_viewer.css', 'pdf_viewer.css'],
  ['LICENSE', 'LICENSE'],
]);
const DIRS = new Map([['standard_fonts/', 'standard_fonts/'], ['cmaps/', 'cmaps/'], ['wasm/', 'wasm/']]);

function target(name) {
  if (!name.startsWith('package/')) return null;
  const rel = name.slice('package/'.length);
  if (FILES.has(rel)) return FILES.get(rel);
  for (const [from, to] of DIRS) if (rel.startsWith(from) && !rel.endsWith('/')) return to + rel.slice(from.length);
  return null;
}

const str = (buf, a, n) => buf.toString('utf8', a, a + n).replace(/\0.*$/s, '');

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(data.toString('utf8', i, sp));
    if (!len) break;
    const rec = data.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function* readTar(buf) {
  let off = 0;
  let paxNext = {};
  let paxGlobal = {};
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let name = str(h, 0, 100);
    const prefix = str(h, 345, 155); // ustar 긴 이름
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 0x30);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'x') { paxNext = parsePax(data); continue; }
    if (type === 'g') { paxGlobal = { ...paxGlobal, ...parsePax(data) }; continue; }
    const meta = { ...paxGlobal, ...paxNext };
    paxNext = {};
    if (meta.path) name = meta.path;
    if (type === '0' || type === '\0') yield { name, data };
  }
}

export async function vendor({ dest = DEST, fetchImpl = fetch } = {}) {
  try {
    if ((await fs.readFile(path.join(dest, 'VERSION'), 'utf8')).trim() === PDFJS_VERSION) {
      console.log(`pdf.js ${PDFJS_VERSION} 이(가) 이미 있습니다.`);
      return false;
    }
  } catch {}
  const res = await fetchImpl(TARBALL);
  if (!res.ok) throw new Error(`내려받기 실패: HTTP ${res.status}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const digest = `sha512-${crypto.createHash('sha512').update(tgz).digest('base64')}`;
  if (digest !== INTEGRITY) throw new Error('무결성 검증 실패: 받은 파일의 sha512가 고정값과 다릅니다.');
  const tar = zlib.gunzipSync(tgz);
  await fs.rm(dest, { recursive: true, force: true });
  let count = 0;
  for (const { name, data } of readTar(tar)) {
    const rel = target(name);
    if (!rel) continue;
    const file = path.join(dest, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    count += 1;
  }
  if (count === 0) throw new Error('tarball에서 파일을 찾지 못했습니다.');
  await fs.writeFile(path.join(dest, 'VERSION'), `${PDFJS_VERSION}\n`);
  console.log(`pdf.js ${PDFJS_VERSION}: ${count}개 파일을 ${dest} 에 넣었습니다.`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  vendor().catch((e) => { console.error(e.message); process.exit(1); });
}
