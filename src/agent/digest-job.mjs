import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPrompt as defaultBuildPrompt } from './commands.mjs';
import { prepareWorkdir as defaultPrepare, prepareConnectionsWorkdir as defaultPrepareConnections, cleanupWorkdir as defaultCleanup, runAgent as defaultRunAgent } from './run.mjs';
import {
  validateConnections, buildConnectionsPrompt, digestCore, connectionsTaskMd, saveConnections, CONNECTIONS_ATTEMPTS,
} from './connections.mjs';
import { researchHeadings } from '../obsidian/note.mjs';
import { validateDigest } from '../digest/validate.mjs';
import { readPaper } from '../reader/store.mjs';

export const MAX_ATTEMPTS = 3;
const LOG_LINES = 20;
const LOG_CHARS = 200;
const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');
const RULES_FILE = path.join(PROMPTS, 'digest.md');
const CONNECTIONS_RULES = path.join(PROMPTS, 'connections.md');

export const NO_AGENT_MESSAGE = '쓸 수 있는 AI 도구가 없습니다. Claude Code 또는 Codex 중 하나를 설치하고 로그인하세요.';
export const BUSY_MESSAGE = '다른 논문의 요약을 만들고 있습니다.';
export const EXAMPLE_MESSAGE = '예제 논문은 요약을 다시 만들 수 없습니다.';
export const NOT_FOUND_MESSAGE = '논문을 찾을 수 없습니다.';
export const UNEXPECTED_MESSAGE = '요약을 만들지 못했습니다. 기존 요약은 그대로입니다. 서버 로그를 확인하세요.';
export const TIMEOUT_MESSAGE = '시간이 너무 오래 걸려 멈췄습니다.';
export const CONNECTIONS_BUSY_MESSAGE = '연구 연결 메모를 만들고 있습니다. 끝난 뒤 다시 시도하세요.';
export const CONNECTIONS_EXAMPLE_MESSAGE = '예제 논문은 연구 연결 메모를 만들 수 없습니다.';
export const NO_HEADINGS_MESSAGE = '연구 주제 노트에 제목(#)이 없어 연결할 대상이 없습니다. 노트에 제목을 달아 주세요.';
export const RESEARCH_TOO_LARGE_MESSAGE = '연구 주제 노트가 너무 큽니다 (최대 20만 자).';
const MAX_RESEARCH_CHARS = 200_000;
export const HAS_DIGEST_MESSAGE = "이미 요약이 있는 논문입니다. 다시 만들려면 논문 화면에서 '요약 다시 만들기'를 누르세요.";

const REVISION = /-r(\d+)$/;

/**
 * Card memos and read progress are keyed by card id. When a digest replaces an older one, its cards
 * get ids no earlier digest used (`<id>-r<N>`, N = 1 + highest revision in the old ids), so old memos
 * never attach to different content. Digest fields hold no other card-id references. Pure.
 */
export function reviseCardIds(digest, oldDigest) {
  const oldCards = Array.isArray(oldDigest?.cards) ? oldDigest.cards : null;
  if (!oldCards || !Array.isArray(digest?.cards)) return digest;
  let top = 0;
  for (const c of oldCards) {
    const m = typeof c?.id === 'string' ? REVISION.exec(c.id) : null;
    if (m) top = Math.max(top, Number(m[1]));
  }
  const n = top + 1;
  const used = new Set();
  const cards = digest.cards.map((c, idx) => {
    const id = (typeof c?.id === 'string' && c.id) || `c${idx + 1}`;
    let next = `${id.replace(REVISION, '')}-r${n}`;
    if (used.has(next)) next = `${id}-r${n}`;
    used.add(next);
    return { ...c, id: next };
  });
  return { ...digest, cards };
}

export class DigestJobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

const baseOf = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '…';
const QUOTED_PATH = /(['"`])((?:~|[A-Za-z]:)?[\\/][^'"`\n]*)\1/g;
const FILE_URL = /file:\/\/[^\s'"`)\]]*/g;
const BARE_PATH = /(^|[\s(\[=,:])((?:~|[A-Za-z]:)?[\\/](?:[^\s'"`\\/)\]]+[\\/])+[^\s'"`\\/)\]]*)/g;

/** Replaces absolute (or ~/) file paths in text with their basename, so job state never carries personal paths. */
export function redactPaths(text) {
  return String(text ?? '')
    .replace(FILE_URL, (m) => baseOf(m.slice('file://'.length).replace(/^[^/]*/, '')))
    .replace(QUOTED_PATH, (m, q, p) => `${q}${baseOf(p)}${q}`)
    .replace(BARE_PATH, (m, pre, p) => (/^[\\/]{2}/.test(p) ? m : `${pre}${baseOf(p)}`));
}

/**
 * One AI job at a time (any paper, any kind). Kinds:
 *  'digest'       writes digest.json (3 attempts; folder PDFs are extracted first)
 *  'connections'  writes connections.json from the paper + the research note (2 attempts)
 * deps:
 *  selectAgent() => Promise<id | { agent, profile?, configDir? } | null>   (configDir stays out of job state)
 *  findFolderPdf(id) => Promise<boolean>   (scanned folder PDF not yet extracted)
 *  extract(id) => Promise                  (stage 2 extraction; shares its busy flag)
 *  researchNote() => Promise<{ path, name, text }>  (the research note, read from the vault; throws { status, message })
 *  recordModel({ agent, profile?, model }) => Promise  (the model a run reported; failures are ignored)
 *  runAgent, prepareWorkdir, prepareConnectionsWorkdir, cleanupWorkdir, buildPrompt, rulesFile, connectionsRules,
 *  examplesDir, timeoutMs  (overridable)
 */
export function createDigestJobs({ cfg, deps = {} }) {
  const {
    selectAgent = async () => null,
    findFolderPdf = async () => false,
    extract = async () => { throw new Error('추출할 수 없습니다.'); },
    researchNote = async () => { throw new DigestJobError(400, 'Obsidian 설정에서 연구 주제 노트를 먼저 고르세요.'); },
    runAgent = defaultRunAgent,
    prepareWorkdir = defaultPrepare,
    prepareConnectionsWorkdir = defaultPrepareConnections,
    cleanupWorkdir = defaultCleanup,
    buildPrompt = defaultBuildPrompt,
    rulesFile = RULES_FILE,
    connectionsRules = CONNECTIONS_RULES,
    examplesDir,
    timeoutMs,
    recordModel = async () => {},
    shutdownWaitMs = 10_000,
  } = deps;
  const out = cfg.outputDir;
  const readOpts = examplesDir === undefined ? {} : { examplesDir };
  const last = { digest: new Map(), connections: new Map() }; // kind -> paperId -> job (public state)
  let current = null; // { job, kind, cancelled, handle, settled } | 'starting'

  const snapshot = (job) => (job ? { ...job, log: [...job.log], ...(job.problems ? { problems: [...job.problems] } : {}) } : null);

  function addLog(job, line) {
    const s = redactPaths(line);
    job.log.push(s.length > LOG_CHARS ? s.slice(0, LOG_CHARS) : s);
    if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
  }

  async function readJsonFile(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return undefined; }
  }

  async function replaceDigest(paperDir, digest) {
    const target = path.join(paperDir, 'digest.json');
    const tmp = path.join(paperDir, `.digest.json.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify(digest, null, 2)}\n`);
    try {
      try {
        await fs.copyFile(target, path.join(paperDir, 'digest.prev.json'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  // Per-kind steps of a job. `before` may change the paper (merge) or end the job early (returns an outcome).
  const SPECS = {
    digest: {
      maxAttempts: MAX_ATTEMPTS,
      output: 'digest.json',
      writingLog: (n) => `${n}번째 시도: 요약을 쓰는 중`,
      keepNote: '기존 요약은 그대로입니다.',
      unexpected: UNEXPECTED_MESSAGE,
      doneMessage: '새 요약이 준비되었습니다.',
      cancelledMessage: '요약 만들기를 취소했습니다.',
      fallbackMessage: '요약을 만들지 못했습니다.',
      async before(ctx) {
        const { job } = ctx;
        if (!ctx.needsExtract) return null;
        addLog(job, 'PDF에서 본문을 추출하는 중');
        try {
          const r = await extract(job.paperId);
          if (r?.merged && typeof r.id === 'string' && r.id !== job.paperId) {
            // Same PDF already extracted under another id: digest that paper instead of a duplicate.
            job.paperId = r.id;
            ctx.ids.add(r.id);
            last.digest.set(r.id, job);
            ctx.paperDir = path.join(out, r.id);
            // It already has a summary: regenerating is the paper view's explicit '요약 다시 만들기'.
            if (r.state === 'digest' || (await readJsonFile(path.join(ctx.paperDir, 'digest.json'))) !== undefined) {
              return { state: 'done', existing: true, message: HAS_DIGEST_MESSAGE };
            }
            addLog(job, `이미 추출된 같은 논문(${r.id})으로 진행합니다.`);
          }
        } catch (err) {
          if (ctx.cancelled) return null;
          return { state: 'failed', message: firstLine(err) || '추출에 실패했습니다.' };
        }
        return null;
      },
      prepare: (ctx, prev) => prepareWorkdir({ source: ctx.sourceFile, digestRules: rulesFile, ...(prev ? { previousDigest: prev } : {}) }),
      prompt: (attempt, problems) => buildPrompt({ attempt, problems }),
      check(ctx, raw) {
        const problems = validateDigest(raw, ctx.source).problems;
        if (raw && typeof raw === 'object' && raw.paperId !== ctx.source.id) {
          problems.push(`paperId가 source.json의 id(${ctx.source.id})와 다릅니다`);
        }
        return problems;
      },
      save: async (ctx, raw) => replaceDigest(ctx.paperDir, reviseCardIds(raw, await readJsonFile(path.join(ctx.paperDir, 'digest.json')))),
    },
    connections: {
      maxAttempts: CONNECTIONS_ATTEMPTS,
      output: 'connections.json',
      writingLog: (n) => `${n}번째 시도: 연구 연결 메모를 쓰는 중`,
      keepNote: '기존 연결 메모는 그대로입니다.',
      unexpected: '연결 메모를 만들지 못했습니다. 기존 연결 메모는 그대로입니다. 서버 로그를 확인하세요.',
      doneMessage: '연구 연결 메모가 준비되었습니다.',
      cancelledMessage: '연결 메모 만들기를 취소했습니다.',
      fallbackMessage: '연결 메모를 만들지 못했습니다.',
      before: async () => null,
      async prepare(ctx, prev) {
        if (ctx.digestCoreText === undefined) ctx.digestCoreText = digestCore((await readJsonFile(path.join(ctx.paperDir, 'digest.json'))) ?? null);
        return prepareConnectionsWorkdir({
          source: ctx.source,
          rules: connectionsRules,
          researchText: ctx.research.text,
          taskText: connectionsTaskMd(ctx.source.id, ctx.research.name),
          digestCoreText: ctx.digestCoreText,
          ...(prev ? { previous: prev } : {}),
        });
      },
      prompt: (attempt, problems) => buildConnectionsPrompt({ attempt, problems }),
      check: (ctx, raw) => validateConnections(raw, ctx.source, ctx.headings).problems,
      async save(ctx, raw) {
        const { connections } = validateConnections(raw, ctx.source, ctx.headings);
        await saveConnections(out, ctx.job.paperId, {
          ...connections,
          researchNote: ctx.research.path,
          createdAt: new Date().toISOString(),
          agent: ctx.job.agent,
          model: ctx.model ?? null,
        });
      },
    },
  };

  async function run(ctx) {
    const { job } = ctx;
    const spec = SPECS[ctx.kind];
    ctx.paperDir = path.join(out, job.paperId);
    let workdir = null;
    // The terminal state is published only in `finally`, together with finishedAt, after cleanup.
    let outcome = null;
    const fail = (message) => { outcome = { state: 'failed', message: redactPaths(message) }; };
    try {
      const early = await spec.before(ctx);
      if (ctx.cancelled) return;
      if (early) {
        if (early.state === 'failed') return fail(early.message);
        outcome = early;
        return;
      }
      ctx.sourceFile = path.join(ctx.paperDir, 'source.json');
      ctx.source = await readJsonFile(ctx.sourceFile);
      if (!ctx.source) return fail('source.json을 읽을 수 없습니다.');

      let problems = [];
      for (let attempt = 1; attempt <= spec.maxAttempts; attempt += 1) {
        if (ctx.cancelled) return;
        job.attempt = attempt;
        job.state = attempt === 1 ? 'writing' : 'retrying';
        // Fresh workdir per attempt; the previous attempt's output file carries over.
        const prevDir = workdir;
        const prevOut = prevDir ? path.join(prevDir, spec.output) : null;
        try {
          workdir = await spec.prepare(ctx, prevOut && (await fs.access(prevOut).then(() => true, () => false)) ? prevOut : null);
        } catch (err) {
          workdir = prevDir;
          const msg = firstLine(err);
          return fail(msg.startsWith('임시 작업 폴더') ? msg : '임시 작업 폴더를 준비하지 못했습니다.');
        }
        if (prevDir) await cleanupWorkdir(prevDir);
        if (ctx.cancelled) return;
        addLog(job, spec.writingLog(attempt));
        ctx.handle = runAgent({
          id: job.agent,
          ...(ctx.configDir ? { configDir: ctx.configDir } : {}),
          ...(job.profile ? { label: job.profile } : {}),
          workdir,
          prompt: spec.prompt(attempt, problems),
          onLog: (line) => addLog(job, line),
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        const result = await ctx.handle.done;
        ctx.handle = null;
        if (result.model) {
          ctx.model = result.model;
          try { await recordModel({ agent: job.agent, ...(job.profile ? { profile: job.profile } : {}), model: result.model }); } catch (err) { console.error('[digest-job] recordModel', err?.code ?? ''); }
        }
        if (ctx.cancelled) return;
        if (result.timedOut) return fail(TIMEOUT_MESSAGE);
        if (result.code !== 0) {
          return fail(result.errorHint ?? `AI 도구가 오류로 끝났습니다${result.code === null ? '' : ` (종료 코드 ${result.code})`}. ${spec.keepNote}`);
        }
        job.state = 'checking';
        const raw = await readJsonFile(path.join(workdir, spec.output));
        problems = raw === undefined
          ? [`${spec.output}이 없거나 JSON 형식이 올바르지 않습니다 – 작업 폴더에 ${spec.output}을 쓰세요`]
          : spec.check(ctx, raw);
        if (!problems.length) {
          if (ctx.cancelled) return;
          await spec.save(ctx, raw);
          outcome = { state: 'done', message: spec.doneMessage };
          delete job.problems;
          return;
        }
        job.problems = problems.slice(0, 50);
        addLog(job, `검증 문제 ${problems.length}건`);
      }
      fail(`${spec.maxAttempts}번 시도했지만 검증을 통과하지 못했습니다. ${spec.keepNote}`);
    } catch (err) {
      // Raw fs errors carry absolute paths: log them on the server only.
      console.error('[digest-job]', err);
      fail(`${spec.unexpected}${/^E[A-Z]+$/.test(err?.code ?? '') ? ` (${err.code})` : ''}`);
    } finally {
      if (!outcome) outcome = ctx.cancelled ? { state: 'cancelled', message: spec.cancelledMessage } : { state: 'failed', message: spec.fallbackMessage };
      if (workdir) await cleanupWorkdir(workdir).catch(() => {});
      Object.assign(job, outcome, { finishedAt: new Date().toISOString() });
      if (current === ctx) current = null;
    }
  }

  // Connections: the paper must exist (no extraction) and the research note must have headings.
  async function connectionsInput(paperId, paper) {
    if (paper?.example) throw new DigestJobError(400, CONNECTIONS_EXAMPLE_MESSAGE);
    if (!paper) throw new DigestJobError(404, NOT_FOUND_MESSAGE);
    const note = await researchNote();
    const text = typeof note?.text === 'string' ? note.text : '';
    if (text.length > MAX_RESEARCH_CHARS) throw new DigestJobError(400, RESEARCH_TOO_LARGE_MESSAGE);
    const headings = researchHeadings(text);
    if (!headings.length) throw new DigestJobError(400, NO_HEADINGS_MESSAGE);
    return { research: { path: String(note.path ?? ''), name: String(note.name ?? ''), text }, headings };
  }

  async function start(paperId, { kind = 'digest' } = {}) {
    if (!SPECS[kind]) throw new DigestJobError(400, '알 수 없는 작업 종류입니다.');
    if (current) throw new DigestJobError(409, current !== 'starting' && current.kind === 'connections' ? CONNECTIONS_BUSY_MESSAGE : BUSY_MESSAGE);
    current = 'starting';
    try {
      const paper = await readPaper(out, paperId, readOpts);
      let needsExtract = false;
      let extra = {};
      if (kind === 'connections') {
        extra = await connectionsInput(paperId, paper);
      } else {
        if (paper?.example) throw new DigestJobError(400, EXAMPLE_MESSAGE);
        if (!paper) {
          if (!(await findFolderPdf(paperId))) throw new DigestJobError(404, NOT_FOUND_MESSAGE);
          needsExtract = true;
        }
      }
      const picked = await selectAgent();
      const agent = typeof picked === 'string' ? picked : picked?.agent;
      if (!agent) throw new DigestJobError(400, NO_AGENT_MESSAGE);
      const profile = typeof picked === 'object' && typeof picked.profile === 'string' ? picked.profile : undefined;
      const job = {
        id: randomUUID(),
        kind,
        paperId,
        agent,
        ...(profile ? { profile } : {}),
        state: needsExtract ? 'extracting' : 'writing',
        attempt: needsExtract ? 0 : 1,
        maxAttempts: SPECS[kind].maxAttempts,
        log: [],
        startedAt: new Date().toISOString(),
      };
      const ctx = {
        job, kind, needsExtract, ...extra,
        ids: new Set([paperId]), cancelled: false, handle: null, settled: null,
        configDir: typeof picked === 'object' ? picked.configDir ?? null : null,
      };
      current = ctx;
      last[kind].set(paperId, job);
      ctx.settled = run(ctx);
      return snapshot(job);
    } catch (err) {
      if (current === 'starting') current = null;
      throw err;
    }
  }

  function cancel(paperId, kind = 'digest') {
    const ctx = current;
    if (!ctx || ctx === 'starting' || ctx.kind !== kind || !ctx.ids.has(paperId) || ctx.cancelled) return false;
    ctx.cancelled = true;
    ctx.handle?.cancel();
    return true;
  }

  async function shutdown() {
    const ctx = current;
    if (!ctx || ctx === 'starting') return;
    ctx.cancelled = true;
    ctx.handle?.cancel();
    // An in-flight extraction cannot be interrupted; do not hang the exit on it forever.
    let timer;
    await Promise.race([ctx.settled, new Promise((r) => { timer = setTimeout(r, shutdownWaitMs); })]);
    clearTimeout(timer);
  }

  return { start, get: (paperId, kind = 'digest') => snapshot(last[kind]?.get(paperId)), cancel, shutdown };
}
