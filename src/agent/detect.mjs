import { execFile } from 'node:child_process';
import { redactPaths } from './digest-job.mjs';

export const AGENTS = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude' },
  { id: 'codex', name: 'Codex', cmd: 'codex' },
  // Policy/settings keys we write were checked against 0.46; outside this range they may mean something else.
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', range: { min: [0, 46], below: [1, 0] } },
];

function inRange(version, { min, below }) {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2])];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
  return cmp(v, min) >= 0 && cmp(v, below) < 0;
}

// Default runner: never rejects for a non-zero exit; a spawn failure (ENOENT, timeout) rejects with err.code.
function defaultRun(cmd, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 16 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (typeof err.code === 'number') return resolve({ code: err.code, stdout, stderr });
      if (err.killed || err.signal) return reject(Object.assign(new Error('5초 안에 응답하지 않았습니다'), { code: 'ETIMEDOUT' }));
      reject(err);
    });
  });
}

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

async function detectOne({ id, name, cmd, range }, run) {
  try {
    const r = await run(cmd, ['--version'], { timeoutMs: 5000 });
    if (r.code === 0 && range) {
      const version = firstLine(r.stdout);
      if (!inRange(version, range)) {
        const want = `${range.min.join('.')} 이상 ${range.below.join('.')} 미만`;
        return { id, name, available: false, message: `안전하게 실행할 수 없는 버전입니다 (지원: ${want}, 설치됨: ${redactPaths(version).slice(0, 40) || '알 수 없음'})` };
      }
    }
    if (r.code === 0) return { id, name, available: true, version: firstLine(r.stdout) || undefined };
    const why = firstLine(r.stderr) || firstLine(r.stdout) || `종료 코드 ${r.code}`;
    return { id, name, available: false, message: `실행할 수 없습니다: ${redactPaths(why).slice(0, 200)}` };
  } catch (err) {
    if (err?.code === 'ENOENT') return { id, name, available: false, message: '설치되어 있지 않습니다' };
    return { id, name, available: false, message: `실행할 수 없습니다: ${redactPaths(firstLine(err?.message)).slice(0, 200)}` };
  }
}

export async function detectAgents({ run = defaultRun } = {}) {
  return Promise.all(AGENTS.map((a) => detectOne(a, run)));
}
