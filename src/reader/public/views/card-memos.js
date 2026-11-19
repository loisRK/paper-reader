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

// Returns { bannerNode, memoNode(cardId), reset(), update(notes), dispose() }.
export function setupCardMemos({ id, actions, example = false, getMode, refresh }) {
  const text = new Map();   // cardId -> latest known text (local edits win over polls)
  const areas = new Map();  // cardId -> { area, status, details, d, dirty, saving }
  let disposed = false;
  const bannerNode = el('div', { class: 'memo-conflict-slot' });

  const entryStatus = (e, label) => { e.status.textContent = label; };

  async function save(cardId, e) {
    const value = e.area.value;
    e.saving += 1;
    entryStatus(e, '저장 중…');
    try {
      await actions.saveCardMemo(id, cardId, value);
      e.failed = false;
      if (e.area.value === value) { e.dirty = false; entryStatus(e, '저장됨'); }
    } catch (err) {
      e.failed = true;
      entryStatus(e, '저장 실패');
      actions.toast(`메모를 저장하지 못했습니다: ${err.message}`);
    } finally {
      e.saving -= 1;
    }
  }

  function memoNode(cardId) {
    if (!memosVisible(getMode(), example)) return null;
    const area = el('textarea', {
      rows: 3, maxlength: MEMO_MAX, placeholder: '이 카드에 대한 내 메모', 'aria-label': '카드 메모',
    });
    area.value = text.get(cardId) ?? '';
    const status = el('span', { class: 'memo-status muted', role: 'status' });
    const e = { area, status, dirty: false, saving: 0, failed: false, d: null, details: null };
    // Sequential saves per card: wait for an in-flight one so older text can't land last.
    let chain = Promise.resolve();
    e.d = debounce(() => { chain = chain.then(() => save(cardId, e)); }, SAVE_MS);
    area.addEventListener('input', () => {
      text.set(cardId, area.value);
      e.dirty = true;
      entryStatus(e, '저장 중…');
      e.d();
    });
    area.addEventListener('blur', () => e.d.flush());
    e.details = el('details', { class: 'card-memo', open: area.value !== '' },
      el('summary', { text: '📝 내 메모' }), area, status);
    e.details.addEventListener('click', (ev) => ev.stopPropagation());
    areas.set(cardId, e);
    return e.details;
  }

  const busy = (e) => e.dirty || e.saving > 0 || document.activeElement === e.area;

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

  return {
    bannerNode,
    memoNode,
    // Called before the card list is rebuilt: send pending text and forget the old textareas.
    reset() {
      for (const e of areas.values()) e.d.flush();
      areas.clear();
    },
    update(notes) {
      if (disposed) return;
      renderConflict(notes);
      const memos = notes?.cardMemos ?? {};
      for (const [cardId, value] of Object.entries(memos)) {
        const e = areas.get(cardId);
        if (!e) { text.set(cardId, value); continue; }
        if (busy(e)) continue;
        text.set(cardId, value);
        if (e.area.value !== value) e.area.value = value;
        if (value !== '') e.details.open = true;
      }
      // A memo deleted elsewhere clears the textarea (unless being edited).
      for (const [cardId, e] of areas) {
        if (cardId in memos || busy(e) || e.area.value === '') continue;
        text.set(cardId, '');
        e.area.value = '';
      }
    },
    dispose() {
      for (const e of areas.values()) e.d.flush();
      disposed = true;
    },
  };
}
