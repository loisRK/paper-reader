import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPrompt as defaultBuildPrompt } from './commands.mjs';
import { prepareWorkdir as defaultPrepare, cleanupWorkdir as defaultCleanup, runAgent as defaultRunAgent } from './run.mjs';
import { validateDigest } from '../digest/validate.mjs';
import { readPaper } from '../reader/store.mjs';

export const MAX_ATTEMPTS = 3;
const LOG_LINES = 20;
const LOG_CHARS = 200;
const RULES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'digest.md');

export const NO_AGENT_MESSAGE = '쓸 수 있는 AI 도구가 없습니다. Claude Code, Codex, Gemini CLI 중 하나를 설치하고 로그인하세요.';
export const BUSY_MESSAGE = '다른 논문의 요약을 만들고 있습니다.';
export const EXAMPLE_MESSAGE = '예제 논문은 요약을 다시 만들 수 없습니다.';
export const NOT_FOUND_MESSAGE = '논문을 찾을 수 없습니다.';
export const UNEXPECTED_MESSAGE = '요약을 만들지 못했습니다. 기존 요약은 그대로입니다. 서버 로그를 확인하세요.';
export const TIMEOUT_MESSAGE = '시간이 너무 오래 걸려 멈췄습니다.';

export class DigestJobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

const baseOf = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '…';
const QUOTED_PATH = /(['"`])((?:~|[A-Za-z]:)?[\\/][^'"`\n]*)\1/g;
const BARE_PATH = /(^|[\s(\[=,:])((?:~|[A-Za-z]:)?[\\/](?:[^\s'"`\\/)\]]+[\\/])+[^\s'"`\\/)\]]*)/g;

/** Replaces absolute (or ~/) file paths in text with their basename, so job state never carries personal paths. */
export function redactPaths(text) {
  return String(text ?? '')
    .replace(QUOTED_PATH, (m, q, p) => `${q}${baseOf(p)}${q}`)
    .replace(BARE_PATH, (m, pre, p) => (/^[\\/]{2}/.test(p) ? m : `${pre}${baseOf(p)}`));
}

/**
 * One digest job at a time (any paper). deps:
 *  selectAgent() => Promise<'claude'|'codex'|null>
 *  findFolderPdf(id) => Promise<boolean>   (scanned folder PDF not yet extracted)
 *  extract(id) => Promise                  (stage 2 extraction; shares its busy flag)
 *  recordModel({ agent, model }) => Promise  (the model a run reported; failures are ignored)
 *  runAgent, prepareWorkdir, cleanupWorkdir, buildPrompt, rulesFile, examplesDir, timeoutMs  (overridable)
 */
export function createDigestJobs({ cfg, deps = {} }) {
  const {
    selectAgent = async () => null,
    findFolderPdf = async () => false,
    extract = async () => { throw new Error('추출할 수 없습니다.'); },
    runAgent = defaultRunAgent,
    prepareWorkdir = defaultPrepare,
    cleanupWorkdir = defaultCleanup,
    buildPrompt = defaultBuildPrompt,
    rulesFile = RULES_FILE,
    examplesDir,
    timeoutMs,
    recordModel = async () => {},
    shutdownWaitMs = 10_000,
  } = deps;
  const out = cfg.outputDir;
  const readOpts = examplesDir === undefined ? {} : { examplesDir };
  const last = new Map(); // paperId -> job (public state)
  let current = null; // { job, cancelled, handle, settled } | 'starting'

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

  async function run(ctx, needsExtract) {
    const { job } = ctx;
    let paperDir = path.join(out, job.paperId);
    let workdir = null;
    // The terminal state is published only in `finally`, together with finishedAt, after cleanup.
    let outcome = null;
    const fail = (message) => { outcome = { state: 'failed', message: redactPaths(message) }; };
    try {
      if (needsExtract) {
        addLog(job, 'PDF에서 본문을 추출하는 중');
        try {
          const r = await extract(job.paperId);
          if (r?.merged && typeof r.id === 'string' && r.id !== job.paperId) {
            // Same PDF already extracted under another id: digest that paper instead of a duplicate.
            addLog(job, `이미 추출된 같은 논문(${r.id})으로 진행합니다.`);
            job.paperId = r.id;
            ctx.ids.add(r.id);
            last.set(r.id, job);
            paperDir = path.join(out, r.id);
          }
        } catch (err) {
          if (ctx.cancelled) return;
          return fail(firstLine(err) || '추출에 실패했습니다.');
        }
        if (ctx.cancelled) return;
      }
      const sourceFile = path.join(paperDir, 'source.json');
      const source = await readJsonFile(sourceFile);
      if (!source) return fail('source.json을 읽을 수 없습니다.');

      let problems = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (ctx.cancelled) return;
        job.attempt = attempt;
        job.state = attempt === 1 ? 'writing' : 'retrying';
        // Fresh workdir per attempt; the previous attempt's digest.json carries over.
        const prevDir = workdir;
        const prevDigest = prevDir ? path.join(prevDir, 'digest.json') : null;
        try {
          workdir = await prepareWorkdir({
            source: sourceFile,
            digestRules: rulesFile,
            ...(prevDigest && (await fs.access(prevDigest).then(() => true, () => false)) ? { previousDigest: prevDigest } : {}),
          });
        } catch (err) {
          workdir = prevDir;
          const msg = firstLine(err);
          return fail(msg.startsWith('임시 작업 폴더') ? msg : '임시 작업 폴더를 준비하지 못했습니다.');
        }
        if (prevDir) await cleanupWorkdir(prevDir);
        if (ctx.cancelled) return;
        addLog(job, `${attempt}번째 시도: 요약을 쓰는 중`);
        ctx.handle = runAgent({
          id: job.agent,
          workdir,
          prompt: buildPrompt({ attempt, problems }),
          onLog: (line) => addLog(job, line),
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        const result = await ctx.handle.done;
        ctx.handle = null;
        if (result.model) {
          try { await recordModel({ agent: job.agent, model: result.model }); } catch (err) { console.error('[digest-job] recordModel', err?.code ?? ''); }
        }
        if (ctx.cancelled) return;
        if (result.timedOut) return fail(TIMEOUT_MESSAGE);
        if (result.code !== 0) {
          return fail(result.errorHint ?? `AI 도구가 오류로 끝났습니다${result.code === null ? '' : ` (종료 코드 ${result.code})`}. 기존 요약은 그대로입니다.`);
        }
        job.state = 'checking';
        const raw = await readJsonFile(path.join(workdir, 'digest.json'));
        if (raw === undefined) {
          problems = ['digest.json이 없거나 JSON 형식이 올바르지 않습니다 – 작업 폴더에 digest.json을 쓰세요'];
        } else {
          problems = validateDigest(raw, source).problems;
          if (raw && typeof raw === 'object' && raw.paperId !== source.id) {
            problems.push(`paperId가 source.json의 id(${source.id})와 다릅니다`);
          }
        }
        if (!problems.length) {
          if (ctx.cancelled) return;
          await replaceDigest(paperDir, raw);
          outcome = { state: 'done', message: '새 요약이 준비되었습니다.' };
          delete job.problems;
          return;
        }
        job.problems = problems.slice(0, 50);
        addLog(job, `검증 문제 ${problems.length}건`);
      }
      fail(`${MAX_ATTEMPTS}번 시도했지만 검증을 통과하지 못했습니다. 기존 요약은 그대로입니다.`);
    } catch (err) {
      // Raw fs errors carry absolute paths: log them on the server only.
      console.error('[digest-job]', err);
      fail(`${UNEXPECTED_MESSAGE}${/^E[A-Z]+$/.test(err?.code ?? '') ? ` (${err.code})` : ''}`);
    } finally {
      if (!outcome) outcome = ctx.cancelled ? { state: 'cancelled', message: '요약 만들기를 취소했습니다.' } : { state: 'failed', message: '요약을 만들지 못했습니다.' };
      if (workdir) await cleanupWorkdir(workdir).catch(() => {});
      Object.assign(job, outcome, { finishedAt: new Date().toISOString() });
      if (current === ctx) current = null;
    }
  }

  async function start(paperId) {
    if (current) throw new DigestJobError(409, BUSY_MESSAGE);
    current = 'starting';
    try {
      const paper = await readPaper(out, paperId, readOpts);
      let needsExtract = false;
      if (paper?.example) throw new DigestJobError(400, EXAMPLE_MESSAGE);
      if (!paper) {
        if (!(await findFolderPdf(paperId))) throw new DigestJobError(404, NOT_FOUND_MESSAGE);
        needsExtract = true;
      }
      const agent = await selectAgent();
      if (!agent) throw new DigestJobError(400, NO_AGENT_MESSAGE);
      const job = {
        id: randomUUID(),
        paperId,
        agent,
        state: needsExtract ? 'extracting' : 'writing',
        attempt: needsExtract ? 0 : 1,
        maxAttempts: MAX_ATTEMPTS,
        log: [],
        startedAt: new Date().toISOString(),
      };
      const ctx = { job, ids: new Set([paperId]), cancelled: false, handle: null, settled: null };
      current = ctx;
      last.set(paperId, job);
      ctx.settled = run(ctx, needsExtract);
      return snapshot(job);
    } catch (err) {
      if (current === 'starting') current = null;
      throw err;
    }
  }

  function cancel(paperId) {
    const ctx = current;
    if (!ctx || ctx === 'starting' || !ctx.ids.has(paperId) || ctx.cancelled) return false;
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

  return { start, get: (paperId) => snapshot(last.get(paperId)), cancel, shutdown };
}
