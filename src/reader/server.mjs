import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { validateDigest } from '../digest/validate.mjs';
import { registerPaper } from '../zotero/local.mjs';
import { createNotesRoutes } from './notes-routes.mjs';
import { isSafeName, listPaperBundles, readPaper, writeProgress, listSearches, readSearch } from './store.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Content-Type은 application/json이어야 합니다.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, '요청 본문이 너무 큽니다 (최대 1MB).');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '요청 본문이 올바른 JSON이 아닙니다.');
  }
}

function checkName(name, label) {
  if (!isSafeName(name)) throw new HttpError(400, `잘못된 ${label}입니다.`);
  return name;
}

function validProgress(b) {
  return b && typeof b === 'object' && Array.isArray(b.read) && b.read.every((x) => typeof x === 'string')
    && (b.mode === '3min' || b.mode === '10min') && typeof b.focus === 'boolean';
}

function validated(bundle) {
  if (bundle.rawDigest === null) {
    const problems = bundle.digestError ? [`digest.json을 읽을 수 없습니다: ${bundle.digestError}`] : [];
    return bundle.digestError
      ? { digest: validateDigest(null, bundle.source).digest, problems }
      : { digest: null, problems };
  }
  return validateDigest(bundle.rawDigest, bundle.source);
}

async function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, '잘못된 경로입니다.');
  }
  if (rel === '/') rel = '/index.html';
  if (rel.includes('\0')) throw new HttpError(400, '잘못된 경로입니다.');
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, '찾을 수 없습니다.');
  const type = TYPES[path.extname(file)];
  if (!type) throw new HttpError(404, '찾을 수 없습니다.');
  let data;
  try {
    data = await fs.readFile(file);
  } catch {
    throw new HttpError(404, '찾을 수 없습니다.');
  }
  res.writeHead(200, { 'Content-Type': type });
  res.end(data);
}

export function createServer(cfg, deps = {}) {
  const { fetchImpl, examplesDir } = deps;
  const out = cfg.outputDir;
  const opts = { examplesDir };
  const notesRoutes = createNotesRoutes(cfg, { out, opts, fetchImpl, zotero: deps.zotero }, { HttpError, checkName, readBody, sendJson, validated });

  async function route(req, res) {
    const port = server.address()?.port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      throw new HttpError(403, '허용되지 않은 Host입니다.');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(400, '잘못된 경로입니다.'); } });
    const { method } = req;

    if (parts[0] !== 'api') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '허용되지 않는 메서드입니다.');
      return serveStatic(res, url.pathname);
    }

    if (await notesRoutes(req, res, parts, method)) return;

    if (parts[1] === 'papers' && parts.length === 2 && method === 'GET') {
      const list = (await listPaperBundles(out, opts)).map((b) => {
        const { digest } = validated(b);
        const cards = digest?.cards ?? [];
        const ids = new Set(cards.map((c) => c.id));
        return {
          id: b.id,
          example: b.example,
          title: b.source.meta?.title ?? b.id,
          journal: b.source.meta?.journal ?? '',
          date: b.source.meta?.date ?? '',
          hasDigest: b.rawDigest !== null,
          cardsRead: new Set(b.progress.read.filter((r) => ids.has(r))).size,
          cardsTotal: cards.length,
        };
      });
      return sendJson(res, 200, list);
    }

    if (parts[1] === 'papers' && parts.length === 3 && method === 'GET') {
      const id = checkName(parts[2], 'id');
      const b = await readPaper(out, id, opts);
      if (!b) throw new HttpError(404, '논문을 찾을 수 없습니다.');
      const { digest, problems } = validated(b);
      const z = b.source.zotero ?? {};
      return sendJson(res, 200, {
        source: b.source, digest, problems, progress: b.progress, needsReextract: b.needsReextract, example: b.example === true,
        links: {
          zoteroPdf: z.attachmentKey ? `zotero://open-pdf/library/items/${z.attachmentKey}` : null,
          zoteroItem: z.itemKey ? `zotero://select/library/items/${z.itemKey}` : null,
        },
      });
    }

    if (parts[1] === 'papers' && parts.length === 4 && parts[3] === 'progress' && method === 'PUT') {
      const id = checkName(parts[2], 'id');
      const body = await readBody(req);
      if (!validProgress(body)) throw new HttpError(400, 'progress 형식이 올바르지 않습니다: { read: string[], mode: "3min"|"10min", focus: boolean }');
      if (!(await readPaper(out, id, opts))) throw new HttpError(404, '논문을 찾을 수 없습니다.');
      await writeProgress(out, id, { read: body.read, mode: body.mode, focus: body.focus });
      res.writeHead(204);
      return res.end();
    }

    if (parts[1] === 'searches' && parts.length === 2 && method === 'GET') {
      return sendJson(res, 200, await listSearches(out));
    }

    if (parts[1] === 'searches' && parts.length === 3 && method === 'GET') {
      const name = checkName(parts[2], '검색 이름');
      const data = await readSearch(out, name);
      if (!data) throw new HttpError(404, '검색 결과를 찾을 수 없습니다.');
      return sendJson(res, 200, data);
    }

    if (parts[1] === 'register' && parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      const name = checkName(body?.search, '검색 이름');
      const data = await readSearch(out, name);
      if (!data) throw new HttpError(404, '검색 결과를 찾을 수 없습니다.');
      const paper = (data.papers ?? []).find((p) => p.n === body.n);
      if (!paper) throw new HttpError(404, `${body.n}번 논문이 이 검색 결과에 없습니다.`);
      return sendJson(res, 200, await registerPaper(paper, cfg, { fetchImpl }));
    }

    throw new HttpError(404, '찾을 수 없습니다.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        return sendJson(res, err.status, { error: err.message });
      }
      sendJson(res, 500, { error: `서버 오류: ${err.message}` });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (err) {
    console.error(`설정 파일을 읽지 못했습니다: ${String(err.message).split('\n')[0]}`);
    process.exit(1);
  }
  let server;
  try {
    server = createServer(cfg);
  } catch (err) {
    console.error(`읽기 앱을 시작하지 못했습니다: ${String(err.message).split('\n')[0]}`);
    process.exit(1);
  }
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`포트 ${cfg.reader.port}가 사용 중입니다. 설정 reader.port를 바꾸세요.`);
    else console.error(err.message);
    process.exit(1);
  });
  server.listen(cfg.reader.port, '127.0.0.1', () => {
    console.log(`Paper Reader: http://127.0.0.1:${cfg.reader.port}`);
  });
}
