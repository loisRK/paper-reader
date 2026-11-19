// Make-digest UI helpers shared by the list and paper views.
import { el } from './dom.js';
import { createPoller } from './notes.js';

export const POLL_MS = 2000;
const FAIL_PREFIX = '요약을 만들지 못했습니다';

// Pure: what a digest job looks like on screen. null when there is nothing to show.
export function jobView(job) {
  if (!job) return null;
  const max = job.maxAttempts ?? 3;
  switch (job.state) {
    case 'extracting': return { text: 'PDF 추출 중…', busy: true, tone: 'info' };
    case 'writing': return { text: `요약 쓰는 중… (${job.attempt}/${max}번째)`, busy: true, tone: 'info' };
    case 'checking': return { text: '검증 중…', busy: true, tone: 'info' };
    case 'retrying': return { text: `검증 문제 ${job.problems?.length ?? 0}건 — 다시 쓰는 중 (${job.attempt}/${max}번째)`, busy: true, tone: 'info' };
    case 'done': return { text: '요약을 만들었습니다', busy: false, tone: 'ok' };
    case 'failed': {
      const m = job.message?.trim();
      const text = !m ? FAIL_PREFIX : m.startsWith(FAIL_PREFIX) ? m : `${FAIL_PREFIX}: ${m}`;
      return { text, busy: false, tone: 'error' };
    }
    case 'cancelled': return { text: '취소했습니다', busy: false, tone: 'info' };
    default: return null;
  }
}

// Paper ids whose digest job this tab started (the server has no "current job" listing).
// Kept in sessionStorage so a reload keeps showing progress; storage errors fall back to memory.
const TRACK_KEY = 'paper-reader:digest-jobs';
export function digestTracker(storage) {
  let ids = [];
  try {
    const v = JSON.parse(storage?.getItem(TRACK_KEY) ?? '[]');
    if (Array.isArray(v)) ids = v.filter((x) => typeof x === 'string');
  } catch { /* empty */ }
  const save = () => { try { storage?.setItem(TRACK_KEY, JSON.stringify(ids)); } catch { /* memory only */ } };
  return {
    ids: () => [...ids],
    track(id) { if (!ids.includes(id)) { ids.push(id); save(); } },
    untrack(id) { if (ids.includes(id)) { ids = ids.filter((x) => x !== id); save(); } },
  };
}

// Last log line, for a one-line hint under the status.
export const lastLogLine = (job) => (job?.log?.length ? job.log[job.log.length - 1] : '');

// <details> with the job's recent log (server keeps the last 20 lines).
export function logDetails(job, open = false) {
  const lines = job?.log ?? [];
  if (!lines.length) return null;
  return el('details', { class: 'job-log', open },
    el('summary', { text: `로그 보기 (${lines.length}줄)` }),
    el('ol', {}, lines.slice(-20).map((l) => el('li', { text: l }))),
  );
}

// Polls one paper's job every POLL_MS until it is no longer running; onUpdate(job|null) on every fetch.
// Network errors are skipped (the next tick retries).
export function watchJob({ id, actions, onUpdate, ms = POLL_MS }) {
  const poller = createPoller({
    ms,
    async run() {
      let job;
      try { job = await actions.digestJob(id); } catch { return; }
      if (!jobView(job)?.busy) poller.stop();
      onUpdate(job);
    },
  });
  return { start: () => poller.kick(), stop: () => poller.stop() };
}
