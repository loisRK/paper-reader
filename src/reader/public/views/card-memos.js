// Per-card memos under each summary card. Pure helpers are tested in Node;
// the DOM pieces only touch `document` when called. Synced through the notes poller in notes.js.
import { el } from './dom.js';

const SAVE_MS = 800;
const CONFLICT_TEXT = 'Zotero 노트가 직접 수정되어 덮어쓰지 않았습니다.';
export const MEMO_MAX = 5000;

// Calls fn once with the last args after `ms` of quiet. flush() runs a pending call now; cancel() drops it.
export function debounce(fn, ms, { setTimeout: st, clearTimeout: ct } = globalThis) {
  let timer = null;
  let args = null;
  const run = () => { timer = null; const a = args; args = null; if (a) fn(...a); };
  const d = (...a) => {
    args = a;
    if (timer !== null) ct(timer);
    timer = st(run, ms);
  };
  d.flush = () => { if (timer !== null) { ct(timer); run(); } };
  d.cancel = () => { if (timer !== null) ct(timer); timer = null; args = null; };
  return d;
}

// Memos are for 10-minute mode, and never for bundled example papers (writes are 403).
export const memosVisible = (mode, example) => mode === '10min' && !example;

// Local text wins over polled text while it is unsent, failed, in flight, or being typed.
export const shouldApplyRemote = ({ dirty, failed, saving, focused }) => !(dirty || failed || saving > 0 || focused);
// Network errors (no status), 5xx, 408 and 429 may succeed later; other 4xx never will.
export const isRetryable = (status) => !status || status >= 500 || status === 408 || status === 429;
// Polls retry only failures that can heal; toast only when entering the failed state.
export const shouldPollRetry = ({ failed, permanent, saving }) => Boolean(failed && !permanent && !(saving > 0));
export const shouldToast = ({ wasFailed }) => !wasFailed;
// A card whose latest text the server has not acknowledged must be sent again.
export const needsResend = ({ dirty, failed }) => Boolean(dirty || failed);

// Returns { bannerNode, memoNode(cardId), reset(), update(notes), dispose() }.
export function setupCardMemos({ id, actions, example = false, getMode, refresh }) {
  // Per-card state survives reset() (re-render) so unsent text is never lost.
  const cards = new Map();
  let disposed = false;
  const bannerNode = el('div', { class: 'memo-conflict-slot' });

  const label = (st, t) => { if (st.status) st.status.textContent = t; };

  function stateOf(cardId) {
    let st = cards.get(cardId);
    if (!st) {
      st = { text: '', dirty: false, failed: false, permanent: false, saving: 0, chain: Promise.resolve(), area: null, status: null, details: null };
      st.d = debounce(() => enqueue(cardId, st), SAVE_MS);
      cards.set(cardId, st);
    }
    return st;
  }

  // Sequential saves per card; a queued save with nothing left to send is skipped.
  function enqueue(cardId, st) {
    st.chain = st.chain.then(() => save(cardId, st));
  }

  async function save(cardId, st) {
    if (!needsResend(st)) return;
    const value = st.text;
    st.saving += 1;
    label(st, '저장 중…');
    try {
      await actions.saveCardMemo(id, cardId, value);
      st.failed = false;
      st.permanent = false;
      if (st.text === value) { st.dirty = false; label(st, '저장됨'); }
    } catch (err) {
      const wasFailed = st.failed;
      st.failed = true;
      st.permanent = !isRetryable(err.status);
      label(st, '저장 실패');
      if (shouldToast({ wasFailed })) actions.toast(`메모를 저장하지 못했습니다: ${err.message}`);
    } finally {
      st.saving -= 1;
    }
  }

  // Send now when unacknowledged (pending timer, or a failed attempt).
  function resend(cardId, st) {
    if (!needsResend(st)) return;
    st.d.cancel();
    enqueue(cardId, st);
  }

  function memoNode(cardId) {
    if (!memosVisible(getMode(), example)) return null;
    const st = stateOf(cardId);
    const area = el('textarea', {
      rows: 3, maxlength: MEMO_MAX, placeholder: '이 카드에 대한 내 메모', 'aria-label': '카드 메모',
    });
    area.value = st.text;
    st.area = area;
    st.status = el('span', { class: 'memo-status muted', role: 'status' });
    label(st, st.failed ? '저장 실패' : st.dirty || st.saving ? '저장 중…' : '');
    area.addEventListener('input', () => {
      st.text = area.value;
      st.dirty = true;
      label(st, '저장 중…');
      st.d();
    });
    area.addEventListener('blur', () => resend(cardId, st));
    st.details = el('details', { class: 'card-memo', open: area.value !== '' },
      el('summary', { text: '📝 내 메모' }), area, st.status);
    st.details.addEventListener('click', (ev) => ev.stopPropagation());
    return st.details;
  }

  function renderConflict(notes) {
    const conflict = notes?.note?.conflict;
    if (!conflict || example) { bannerNode.replaceChildren(); return; }
    const resolve = async (choice) => {
      try {
        await actions.resolveNoteConflict(id, choice);
        bannerNode.replaceChildren();
        refresh?.();
      } catch (err) { actions.toast(`메모 처리 실패: ${err.message}`); }
    };
    bannerNode.replaceChildren(el('div', { class: 'conflict memo-conflict', role: 'alert' },
      el('span', { text: CONFLICT_TEXT }),
      el('div', { class: 'pop-actions' },
        el('button', { type: 'button', class: 'btn', text: '내 메모로 덮어쓰기', onclick: () => resolve('overwrite') }),
        el('button', { type: 'button', class: 'btn btn-quiet', text: 'Zotero 내용 유지', onclick: () => resolve('keep-zotero') }))));
  }

  function apply(st, value) {
    st.text = value;
    if (st.area && st.area.value !== value) st.area.value = value;
    if (st.details && value !== '') st.details.open = true;
  }

  const flushAll = () => { for (const [cardId, st] of cards) resend(cardId, st); };
  const onHide = () => flushAll();
  window.addEventListener('pagehide', onHide);

  return {
    bannerNode,
    memoNode,
    // Called before the card list is rebuilt: send unacknowledged text, drop DOM refs only.
    reset() {
      flushAll();
      for (const st of cards.values()) { st.area = null; st.status = null; st.details = null; }
    },
    update(notes) {
      if (disposed) return;
      renderConflict(notes);
      const memos = notes?.cardMemos ?? {};
      for (const [cardId, value] of Object.entries(memos)) {
        const st = stateOf(cardId);
        if (shouldApplyRemote({ ...st, focused: st.area !== null && document.activeElement === st.area })) apply(st, value);
      }
      for (const [cardId, st] of cards) {
        if (cardId in memos || st.text === '') continue;
        if (shouldApplyRemote({ ...st, focused: st.area !== null && document.activeElement === st.area })) apply(st, '');
      }
      // Zotero is reachable again: retry failed cards (at most once per poll).
      if (notes?.status === 'connected') {
        for (const [cardId, st] of cards) if (shouldPollRetry(st)) resend(cardId, st);
      }
    },
    dispose() {
      flushAll();
      disposed = true;
      window.removeEventListener('pagehide', onHide);
    },
  };
}
