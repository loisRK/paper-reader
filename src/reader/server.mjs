import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { validateDigest } from '../digest/validate.mjs';
import { linkToZotero as defaultLinkToZotero } from '../zotero/link.mjs';
import { registerPaper, resolveItem as defaultResolveItem } from '../zotero/local.mjs';
import { createNotesRoutes } from './notes-routes.mjs';
import { readSettings, writeSettings, recordLastModel } from '../library/settings.mjs';
import { configuredModel } from '../agent/models.mjs';
import { claudeProfiles, profileView, lastModelKey } from '../agent/accounts.mjs';
import { detectAgents as defaultDetectAgents } from '../agent/detect.mjs';
import { createLibrary } from '../library/scan.mjs';
import { createExtractJob } from '../library/extract-job.mjs';
import { createDigestJobs } from '../agent/digest-job.mjs';
import { readNotes } from '../notes/store.mjs';
import { buildCompanionNote, companionFileName, researchHeadings } from '../obsidian/note.mjs';
import { writeCompanionNote, listVaultNotes, readVaultNote, resolveVault } from '../obsidian/write.mjs';
import { validateObsidianSettings, DEFAULT_FOLDER } from '../obsidian/settings.mjs';
import { isSafeName, resolvePaperDir, listPaperBundles, readPaper, writeProgress, listSearches, readSearch } from './store.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
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
  const base = path.basename(file);
  const type = TYPES[path.extname(file)] ?? (/^(VERSION|LICENSE(_[A-Z0-9_]+)?)$/.test(base) ? 'text/plain; charset=utf-8' : undefined);
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

async function isPdfFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.pdf') return false;
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

const FIGURE_RE = /^fig-\d+-\d+\.png$/;

async function readFigure(paperDir, name) {
  if (!paperDir) return null;
  try {
    const figDir = await fs.realpath(path.join(paperDir, 'figures'));
    if (figDir !== path.join(await fs.realpath(paperDir), 'figures')) return null;
    const file = path.join(figDir, name);
    if (!(await fs.lstat(file)).isFile()) return null;
    const real = await fs.realpath(file);
    if (!real.startsWith(figDir + path.sep)) return null;
    return await fs.readFile(real);
  } catch {
    return null;
  }
}

const nfc = (s) => s.normalize('NFC');

// Among bundles of the same PDF keep one: has digest, then Zotero-linked, then oldest source.json, then id.
async function preferredOf(out, group) {
  const scored = [];
  for (const b of group) {
    let mtime = Infinity;
    try { mtime = (await fs.stat(path.join(out, b.id, 'source.json'))).mtimeMs; } catch { /* unknown: last */ }
    scored.push({ b, k: [b.rawDigest !== null ? 0 : 1, b.source.zotero ? 0 : 1, mtime] });
  }
  scored.sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.k[2] - y.k[2] || x.b.id.localeCompare(y.b.id));
  return scored[0].b;
}

// Hides (never deletes) all but one bundle per source.pdf.md5.
async function dedupeBundles(out, bundles) {
  const groups = new Map();
  for (const b of bundles) {
    const m = b.example ? null : b.source.pdf?.md5;
    if (typeof m !== 'string' || !m) continue;
    if (groups.has(m)) groups.get(m).push(b); else groups.set(m, [b]);
  }
  const hidden = new Set();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = await preferredOf(out, g);
    for (const b of g) if (b !== keep) hidden.add(b);
  }
  return bundles.filter((b) => !hidden.has(b));
}

export function createServer(cfg, deps = {}) {
  const { fetchImpl, examplesDir, resolveItem = defaultResolveItem, md5File: md5Impl } = deps;
  const dataDir = cfg.dataDir ?? (cfg.zotero?.authFile ? path.dirname(cfg.zotero.authFile) : null);
  const out = cfg.outputDir;
  const detectAgents = deps.detectAgents ?? defaultDetectAgents;
  const linkToZotero = deps.linkToZotero ?? defaultLinkToZotero;
  // One folder library per server: the MD5 worker and its cache are shared by the list and the extract job.
  const library = createLibrary({ dataDir, md5: md5Impl });
  // Every Zotero call on the link path is bounded (default 10 s); a timeout counts as "Zotero off".
  const linkDeps = { fetchImpl, ...(deps.zoteroTimeoutMs ? { timeoutMs: deps.zoteroTimeoutMs } : {}) };
  const opts = { examplesDir };
  // A folder file whose PDF is already a bundle (same MD5, hashed now, or same realpath) is not extracted again.
  async function findDuplicate(file) {
    const md5 = await library.hashNow(file);
    const real = nfc(file.path);
    const matches = [];
    for (const b of await listPaperBundles(out, opts)) {
      if (b.example) continue;
      const p = b.source.pdf;
      let same = typeof p?.md5 === 'string' && p.md5 === md5;
      if (!same && typeof p?.path === 'string') {
        same = nfc(p.path) === real;
        if (!same) { try { same = nfc(await fs.realpath(p.path)) === real; } catch { /* moved */ } }
      }
      if (same) matches.push(b);
    }
    if (!matches.length) return null;
    const keep = await preferredOf(out, matches);
    return { id: keep.id, state: keep.rawDigest !== null ? 'digest' : 'extracted' };
  }
  const runExtract = createExtractJob({
    cfg, dataDir, extractFile: deps.extractFile, linkToZotero, linkDeps, findDuplicate,
    listFiles: (folders) => library.list(folders),
    ...(deps.linkTimeoutMs ? { linkTimeoutMs: deps.linkTimeoutMs } : {}),
  });
  // Each tool's configured model (read-only from its own config) and the model it last reported in a run.
  // Claude also lists its accounts (config dirs from shell aliases); dirs never leave the server.
  const home = deps.home ?? os.homedir();
  const agentEnv = deps.env ?? process.env;
  const savedSettings = async () => (dataDir ? readSettings(dataDir) : { folders: [] });
  async function claudeAccount(saved) {
    const profiles = await claudeProfiles({ home });
    const want = saved.agentProfile?.claude;
    return { profiles, selected: profiles.find((p) => p.label === want) ?? profiles[0] };
  }
  async function withModels(agents) {
    const saved = await savedSettings();
    const lastModels = saved.lastModels ?? {};
    return Promise.all(agents.map(async (a) => {
      if (a.id === 'claude') {
        const { profiles, selected } = await claudeAccount(saved);
        const views = await Promise.all(profiles.map((p) => profileView(p, { home, env: agentEnv, lastModels })));
        const cur = views.find((v) => v.label === selected.label);
        return { ...a, configuredModel: cur.configuredModel, lastModel: cur.lastModel, profiles: views, selectedProfile: cur.label };
      }
      return { ...a, configuredModel: await configuredModel(a.id, { home, env: agentEnv }), lastModel: lastModels[a.id] ?? null };
    }));
  }
  const selectedOf = (agents, saved) => (agents.find((a) => a.id === saved && a.available) ?? agents.find((a) => a.available))?.id ?? null;
  // One digest job at a time; folder PDFs are extracted through runExtract (same busy flag as manual extraction).
  const digestJobs = createDigestJobs({
    cfg,
    deps: {
      examplesDir,
      ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
      selectAgent: async () => {
        const saved = await savedSettings();
        const id = selectedOf(await detectAgents(), saved.agent);
        if (id !== 'claude') return id;
        const { selected } = await claudeAccount(saved);
        return { agent: 'claude', profile: selected.label, configDir: selected.dir };
      },
      findFolderPdf: async (id) => {
        if (!dataDir) return false;
        const { folders } = await readSettings(dataDir);
        if (!folders.length) return false;
        return (await library.list(folders)).files.some((f) => f.id === id);
      },
      extract: (id) => runExtract(id),
      recordModel: async ({ agent, profile, model }) => { if (dataDir) await recordLastModel(dataDir, lastModelKey(agent, profile), model); },
    },
  });
  // Retry linking unlinked folder papers in the background: one at a time, same paper not again within the cooldown.
  const linkCooldownMs = deps.linkCooldownMs ?? 30_000;
  const linkTried = new Map();
  let linking = false;
  function linkInBackground(bundles) {
    if (linking) return;
    const now = Date.now();
    const todo = bundles
      .filter((b) => !b.example && !b.source.zotero && typeof b.source.pdf?.path === 'string'
        && now - (linkTried.get(b.id) ?? -Infinity) >= linkCooldownMs)
      .map((b) => b.id);
    if (!todo.length) return;
    linking = true;
    (async () => {
      for (const id of todo) {
        linkTried.set(id, Date.now());
        try { await linkToZotero(out, id, cfg, linkDeps); } catch { /* quiet; retried on a later list */ }
      }
    })().finally(() => { linking = false; });
  }
  // Obsidian: errors from src/obsidian carry { status, message } without the vault's absolute path.
  const obsidianCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.status) throw new HttpError(err.status, err.message);
      throw new HttpError(500, 'Obsidian 작업 중 오류가 났습니다.');
    }
  };
  async function obsidianView() {
    const o = (await savedSettings()).obsidian;
    let vaultOk = false;
    if (o?.vault) { try { await resolveVault(o.vault); vaultOk = true; } catch { vaultOk = false; } }
    return { vault: o?.vault ?? '', folder: o?.folder ?? DEFAULT_FOLDER, researchNote: o?.researchNote ?? null, vaultOk };
  }
  async function readConnections(id) {
    let raw;
    try {
      raw = await fs.readFile(path.join(out, id, 'connections.json'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null; // not created yet
      throw new HttpError(500, '연결 메모 파일을 읽지 못해 보내지 않았습니다.');
    }
    let c;
    try { c = JSON.parse(raw); } catch { c = null; }
    if (!c || typeof c !== 'object' || !Array.isArray(c.items)) throw new HttpError(500, '연결 메모 파일을 읽지 못해 보내지 않았습니다.');
    return c;
  }
  async function exportToObsidian(id) {
    const o = (await savedSettings()).obsidian;
    if (!o?.vault) throw new HttpError(400, 'Obsidian 설정에서 vault 폴더를 먼저 지정하세요.');
    const b = await readPaper(out, id, opts);
    if (!b) throw new HttpError(404, '논문을 찾을 수 없습니다.');
    const digest = b.rawDigest === null ? null : validated(b).digest;
    // A missing notes.json reads as empty; any other read/parse error stops the export (never rewrite memos as "none").
    let notes = null;
    if (!b.example) {
      try { notes = await readNotes(out, id); } catch { throw new HttpError(500, '메모 파일을 읽지 못해 보내지 않았습니다.'); }
    }
    const connections = digest ? await readConnections(id) : null;
    let headings = null;
    let researchNoteName = null;
    if (o.researchNote) {
      researchNoteName = path.posix.basename(o.researchNote).replace(/\.md$/i, '');
      try { headings = researchHeadings(await readVaultNote(o.vault, o.researchNote)); } catch { headings = []; }
    }
    const citekey = b.source.zotero?.itemKey ? b.source.id : null;
    const managed = buildCompanionNote({
      source: b.source, digest, notes, connections, researchNoteName, citekey, now: new Date(), researchHeadings: headings,
    });
    return obsidianCall(() => writeCompanionNote({ vault: o.vault, folder: o.folder, fileName: companionFileName(b.source), managed }));
  }
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

    if (parts[1] === 'agents' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'selected'))) {
      if (!dataDir) throw new HttpError(500, '데이터 폴더가 설정되지 않았습니다.');
      if (parts.length === 2) {
        if (method !== 'GET') throw new HttpError(405, '허용되지 않는 메서드입니다.');
        const agents = await detectAgents();
        return sendJson(res, 200, { agents: await withModels(agents), selected: selectedOf(agents, (await readSettings(dataDir)).agent) });
      }
      if (method !== 'PUT') throw new HttpError(405, '허용되지 않는 메서드입니다.');
      const body = await readBody(req);
      const agents = await detectAgents();
      if (!agents.some((a) => a.id === body?.agent && a.available)) throw new HttpError(400, '이 AI 도구는 지금 쓸 수 없습니다.');
      let agentProfile;
      if (body.profile !== undefined) {
        const known = body.agent === 'claude' ? (await claudeProfiles({ home })).map((p) => p.label) : [];
        if (typeof body.profile !== 'string' || !known.includes(body.profile)) throw new HttpError(400, '이 계정을 찾을 수 없습니다.');
        agentProfile = { claude: body.profile };
      }
      await writeSettings(dataDir, { agent: body.agent, ...(agentProfile ? { agentProfile } : {}) });
      return sendJson(res, 200, { agents: await withModels(agents), selected: body.agent });
    }

    if (parts[1] === 'obsidian' && parts.length === 3 && (parts[2] === 'settings' || parts[2] === 'notes')) {
      if (!dataDir) throw new HttpError(500, '데이터 폴더가 설정되지 않았습니다.');
      if (parts[2] === 'notes') {
        if (method !== 'GET') throw new HttpError(405, '허용되지 않는 메서드입니다.');
        const o = (await readSettings(dataDir)).obsidian;
        if (!o?.vault) throw new HttpError(400, 'Obsidian 설정에서 vault 폴더를 먼저 지정하세요.');
        return sendJson(res, 200, await obsidianCall(() => listVaultNotes(o.vault)));
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const obsidian = await obsidianCall(() => validateObsidianSettings(body ?? {}));
        await writeSettings(dataDir, { obsidian });
      } else if (method !== 'GET') {
        throw new HttpError(405, '허용되지 않는 메서드입니다.');
      }
      return sendJson(res, 200, await obsidianView());
    }

    if (parts[1] === 'papers' && parts.length === 4 && parts[3] === 'obsidian' && method === 'POST') {
      const id = checkName(parts[2], 'id');
      await readBody(req);
      if (!dataDir) throw new HttpError(500, '데이터 폴더가 설정되지 않았습니다.');
      return sendJson(res, 200, await exportToObsidian(id));
    }

    if (parts[1] === 'library' && parts[2] === 'folders' && parts.length === 3) {
      if (!dataDir) throw new HttpError(500, '데이터 폴더가 설정되지 않았습니다.');
      if (method === 'PUT') {
        const body = await readBody(req);
        try {
          await writeSettings(dataDir, { folders: body?.folders });
        } catch (err) {
          if (err.status === 400) throw new HttpError(400, err.message);
          throw err;
        }
      } else if (method !== 'GET') {
        throw new HttpError(405, '허용되지 않는 메서드입니다.');
      }
      return sendJson(res, 200, await readSettings(dataDir));
    }

    if (parts[1] === 'library' && parts[2] === 'extract' && parts.length === 3) {
      if (method !== 'POST') throw new HttpError(405, '허용되지 않는 메서드입니다.');
      const body = await readBody(req);
      const id = checkName(body?.id, 'id');
      try {
        return sendJson(res, 200, await runExtract(id));
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (parts[1] === 'papers' && parts.length === 2 && method === 'GET') {
      const bundles = await listPaperBundles(out, opts);
      linkInBackground(bundles);
      const list = (await dedupeBundles(out, bundles)).map((b) => {
        const { digest } = validated(b);
        const cards = digest?.cards ?? [];
        const ids = new Set(cards.map((c) => c.id));
        const hasDigest = b.rawDigest !== null;
        return {
          id: b.id,
          example: b.example,
          title: b.source.meta?.title ?? b.id,
          journal: b.source.meta?.journal ?? '',
          date: b.source.meta?.date ?? '',
          hasDigest,
          cardsRead: new Set(b.progress.read.filter((r) => ids.has(r))).size,
          cardsTotal: cards.length,
          state: hasDigest ? 'digest' : 'extracted',
          origin: b.example ? 'example' : b.source.zotero ? 'zotero' : 'folder',
          linked: Boolean(b.source.zotero),
        };
      });
      const folders = [];
      let hashing;
      if (dataDir) {
        const { folders: paths } = await readSettings(dataDir);
        if (paths.length) {
          const scan = await library.list(paths);
          const known = new Set(list.map((p) => p.id));
          const md5s = new Set();
          const reals = new Set();
          for (const b of bundles) {
            if (b.source.pdf?.md5) md5s.add(b.source.pdf.md5);
            if (typeof b.source.pdf?.path === 'string') {
              reals.add(b.source.pdf.path);
              try { reals.add(await fs.realpath(b.source.pdf.path)); } catch { /* moved or on a missing disk */ }
            }
          }
          for (const f of scan.files) {
            if (known.has(f.id) || reals.has(f.path) || (f.md5 && md5s.has(f.md5))) continue;
            known.add(f.id);
            list.push({ id: f.id, title: path.basename(f.rel), state: 'pdf', origin: 'folder', linked: false, file: f.rel });
          }
          hashing = scan.hashing;
          for (const p of paths) {
            const problem = scan.problems.find((x) => x.folder === p && x.message.startsWith('폴더를 찾을 수 없습니다'));
            const warn = scan.problems.find((x) => x.folder === p && !x.message.startsWith('폴더를 찾을 수 없습니다'));
            folders.push(problem ? { path: p, ok: false, message: problem.message } : warn ? { path: p, ok: true, message: warn.message } : { path: p, ok: true });
          }
        }
      }
      return sendJson(res, 200, { papers: list, folders, ...(hashing ? { hashing } : {}) });
    }

    if (parts[1] === 'papers' && parts.length === 3 && method === 'GET') {
      const id = checkName(parts[2], 'id');
      const b = await readPaper(out, id, opts);
      if (!b) throw new HttpError(404, '논문을 찾을 수 없습니다.');
      const { digest, problems } = validated(b);
      const z = b.source.zotero ?? {};
      // links.pdf never calls Zotero: recorded path first, else assume a lookup by itemKey can work.
      const hasPdf = !b.example && ((await isPdfFile(b.source.pdf?.path)) || Boolean(z.itemKey));
      return sendJson(res, 200, {
        source: b.source, digest, problems, progress: b.progress, needsReextract: b.needsReextract, example: b.example === true,
        links: {
          zoteroPdf: z.attachmentKey ? `zotero://open-pdf/library/items/${z.attachmentKey}` : null,
          pdf: hasPdf,
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

    if (parts[1] === 'papers' && parts.length === 4 && parts[3] === 'digest' && method === 'POST') {
      const id = checkName(parts[2], 'id');
      await readBody(req);
      try {
        return sendJson(res, 202, await digestJobs.start(id));
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (parts[1] === 'papers' && parts.length === 4 && parts[3] === 'digest-job' && method === 'GET') {
      const job = digestJobs.get(checkName(parts[2], 'id'));
      if (!job) throw new HttpError(404, '요약 작업이 없습니다.');
      return sendJson(res, 200, job);
    }

    if (parts[1] === 'papers' && parts.length === 5 && parts[3] === 'digest-job' && parts[4] === 'cancel' && method === 'POST') {
      const id = checkName(parts[2], 'id');
      await readBody(req);
      if (!digestJobs.cancel(id)) throw new HttpError(404, '진행 중인 요약 작업이 없습니다.');
      return sendJson(res, 200, digestJobs.get(id));
    }

    if (parts[1] === 'papers' && parts.length === 5 && parts[3] === 'figures' && method === 'GET') {
      const id = checkName(parts[2], 'id');
      if (!FIGURE_RE.test(parts[4])) throw new HttpError(400, '잘못된 그림 이름입니다.');
      const data = await readFigure(await resolvePaperDir(out, id, opts), parts[4]);
      if (!data) throw new HttpError(404, '그림 파일을 찾을 수 없습니다.');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Length': data.length });
      return res.end(data);
    }

    if (parts[1] === 'papers' && parts.length === 4 && parts[3] === 'pdf' && method === 'GET') {
      const id = checkName(parts[2], 'id');
      const b = await readPaper(out, id, opts);
      if (!b) throw new HttpError(404, '논문을 찾을 수 없습니다.');
      let file = !b.example && (await isPdfFile(b.source.pdf?.path)) ? b.source.pdf.path : null;
      if (!file && !b.example && b.source.zotero?.itemKey) {
        try {
          const item = await resolveItem(b.source.zotero.itemKey, cfg, { fetchImpl });
          if (await isPdfFile(item?.pdfPath)) file = item.pdfPath;
        } catch { /* Zotero not running or item gone: treated as not found */ }
      }
      let data = null;
      if (file) {
        try { data = await fs.readFile(file); } catch { data = null; }
      }
      if (!data) throw new HttpError(404, 'PDF 파일을 찾을 수 없습니다. 파일이 옮겨졌다면 다시 추출하세요.');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Length': data.length });
      return res.end(data);
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
  server.digestJobs = digestJobs;
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
  // Leave no AI tool process or temp workdir behind: cancel the running digest job, then exit.
  let stopping = false;
  const stop = async () => {
    if (stopping) return process.exit(1);
    stopping = true;
    try { await server.digestJobs.shutdown(); } catch { /* exit anyway */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
