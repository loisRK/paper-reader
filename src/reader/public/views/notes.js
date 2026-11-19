// Highlights and memos on the source panel. Pure helpers are tested in Node;
// the DOM pieces only touch `document` when called.
import { el } from './dom.js';

// Duplicate of ZOTERO_COLORS in src/zotero/annotations.mjs (source of truth; the
// static root is public/, so the server module can't be imported here).
// tests/views.test.mjs asserts the two lists stay equal.
export const NOTE_COLORS = [
  { name: 'yellow', label: '노랑', value: '#ffd400' },
  { name: 'red', label: '빨강', value: '#ff6666' },
  { name: 'green', label: '초록', value: '#5fb236' },
  { name: 'blue', label: '파랑', value: '#2ea8e5' },
  { name: 'purple', label: '보라', value: '#a28ae5' },
  { name: 'magenta', label: '분홍', value: '#e56eee' },
  { name: 'orange', label: '주황', value: '#f19837' },
  { name: 'gray', label: '회색', value: '#aaaaaa' },
];
const DEFAULT_COLOR = NOTE_COLORS[0].value;
const POLL_MS = 5000;
const READONLY_TEXT = 'Zotero 10 이상에서만 메모를 Zotero로 보낼 수 있습니다. 메모는 이 컴퓨터에 저장됩니다.';
const MULTI_PAGE_TEXT = '한 번에 한 페이지 안에서만 표시할 수 있습니다.';

// ---------- pure helpers ----------

// Ids from anchor to focus (inclusive) in document order; [] when either is unknown.
export function selectionSentenceIds(orderedIds, anchorId, focusId) {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(focusId);
  if (a === -1 || b === -1) return [];
  return orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function sentenceMarks(notes) {
  const map = new Map();
  const push = (sid, mark) => {
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(mark);
  };
  for (const h of notes?.highlights ?? []) {
    for (const sid of h.sentenceIds ?? []) {
      push(sid, { kind: 'mine', color: h.color, comment: h.comment ?? '', hid: h.id });
    }
  }
  for (const z of notes?.zoteroAnnotations ?? []) {
    for (const sid of z.sentenceIds ?? []) {
      push(sid, { kind: 'zotero', color: z.color, comment: z.comment ?? '', key: z.key });
    }
  }
  return map;
}

export const emptyNotes = () => ({
  highlights: [], cardMemos: {}, zoteroAnnotations: [], note: null,
  status: 'readonly', pending: 0, message: null, failed: 0, failedMessage: null, needsReextract: false,
});

// Wraps an async fn so a second call while one is running is ignored (returns undefined).
export function singleFlight(fn) {
  let busy = false;
  return async (...args) => {
    if (busy) return undefined;
    busy = true;
    try { return await fn(...args); } finally { busy = false; }
  };
}

export function statusText(status, pending) {
  switch (status) {
    case 'connected': return 'Zotero 연결됨';
    case 'offline': return `Zotero 연결 대기 중 (보낼 메모 ${pending ?? 0}개)`;
    case 'needs-auth':
    case 'denied': return 'Zotero 쓰기 허용이 필요합니다';
    case 'rate-limited': return 'Zotero 허용 요청이 많아 잠시 후 다시 시도합니다';
    default: return READONLY_TEXT;
  }
}

// Ops Zotero refused permanently (kept on this computer, retried after an edit).
export const failedText = (n) => (n > 0 ? `보내지 못한 메모 ${n}개` : '');

// What the popover shows for a highlight conflict, and which buttons it offers.
export function conflictView(conflict) {
  if (!conflict) return null;
  if (conflict.zoteroDeleted) {
    return { text: `Zotero에서 삭제된 하이라이트입니다. 내가 쓴 내용: ${conflict.mine?.comment ?? ''}`, actions: ['resend', 'delete'] };
  }
  if (conflict.mine?.deleted) return { text: 'Zotero에서 바뀌어 삭제하지 않았습니다.', actions: ['dismiss'] };
  return { text: `Zotero에서 바뀌었습니다. 내가 쓴 내용: ${conflict.mine?.comment ?? ''}`, actions: ['dismiss'] };
}

// ---------- DOM ----------

const sentOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.sent') ?? null;
const isTyping = (t) => t instanceof Element && (t.closest('input, textarea, select, [contenteditable]') !== null);

function swatches(current, onPick) {
  return el('div', { class: 'swatches', role: 'group', 'aria-label': '색' }, NOTE_COLORS.map((c) => {
    const b = el('button', {
      type: 'button', class: 'swatch', title: c.label, 'aria-label': `${c.label} 색`,
      'aria-pressed': String(c.value === current),
      onmousedown: (e) => e.preventDefault(),
      onclick: () => onPick(c.value),
    });
    b.style.setProperty('--sw', c.value);
    return b;
  }));
}

// source: extracted source (blocks, sentences); panel: the .source element.
// Returns { statusNode, dispose }.
export function setupNotes({ id, source, panel, actions, onNotes }) {
  const order = [];
  const pageOf = new Map();
  for (const b of source.blocks ?? []) {
    for (const sid of b.sentenceIds ?? []) { order.push(sid); pageOf.set(sid, b.page); }
  }
  const s = { notes: emptyNotes(), lastJson: null, color: DEFAULT_COLOR, popover: null, pop: null, sel: null, disposed: false };
  const statusNode = el('div', { class: 'notes-status', role: 'status' });
  const toolbar = el('div', { class: 'sel-toolbar', role: 'toolbar', 'aria-label': '선택한 문장 메모', hidden: true });
  document.body.append(toolbar);

  const fail = (err) => actions.toast(`메모 처리 실패: ${err.message}`);

  // ----- status badge -----
  function renderStatus() {
    const n = s.notes;
    if (!s.lastJson) { statusNode.replaceChildren(); return; }
    const needsAuth = n.status === 'needs-auth' || n.status === 'denied';
    statusNode.className = `notes-status st-${n.status}`;
    statusNode.replaceChildren(
      el('span', { class: 'st-badge', text: statusText(n.status, n.pending) }),
      n.failed > 0 ? el('span', { class: 'st-badge st-failed', text: failedText(n.failed), title: n.failedMessage ?? '' }) : null,
      needsAuth ? el('button', {
        type: 'button', class: 'btn btn-quiet', text: 'Zotero 쓰기 허용', 'aria-label': 'Zotero 쓰기 허용 요청',
        onclick: async () => {
          const r = await actions.authorize();
          if (r?.ok) actions.toast('허용되었습니다. Zotero 창에서 "Always Allow(항상 허용)"를 누르면 다음부터 묻지 않습니다.');
          else actions.toast(r?.status === 'rate-limited' ? statusText('rate-limited') : 'Zotero 쓰기 허용을 받지 못했습니다.');
          poll();
        },
      }) : null,
      needsAuth ? el('span', { class: 'muted st-hint', text: 'Zotero 창에서 "Always Allow(항상 허용)"를 누르면 다음부터 묻지 않습니다.' }) : null,
      n.message && n.status !== 'readonly' ? el('span', { class: 'muted st-hint', text: n.message }) : null,
    );
  }

  // ----- marks on the source text -----
  let extras = [];
  function renderMarks() {
    for (const n of extras) n.remove();
    extras = [];
    const marks = sentenceMarks(s.notes);
    for (const n of panel.querySelectorAll('.sent')) {
      const list = marks.get(n.dataset.sid) ?? [];
      const mine = list.find((m) => m.kind === 'mine');
      const zot = list.some((m) => m.kind === 'zotero');
      n.classList.toggle('mark-mine', Boolean(mine));
      n.classList.toggle('mark-zot', zot);
      if (mine) n.style.setProperty('--mark', mine.color); else n.style.removeProperty('--mark');
      if (list.length) { n.tabIndex = 0; n.setAttribute('role', 'button'); n.setAttribute('aria-label', `메모가 있는 문장: ${n.textContent.slice(0, 40)}`); } else {
        n.removeAttribute('tabindex'); n.removeAttribute('role'); n.removeAttribute('aria-label');
      }
    }
    // Zotero annotations without matched sentences: list at the end of their page.
    const loose = (s.notes?.zoteroAnnotations ?? []).filter((z) => !z.sentenceIds?.length);
    const byPage = new Map();
    for (const z of loose) byPage.set(z.page, [...(byPage.get(z.page) ?? []), z]);
    const body = panel.querySelector('.source-body');
    const marksEls = [...panel.querySelectorAll('.page-mark')];
    for (const [page, list] of byPage) {
      const at = marksEls.findIndex((m) => m.textContent === `p.${page}`);
      const next = at === -1 ? null : marksEls[at + 1] ?? panel.querySelector('.refs');
      const box = el('div', { class: 'zot-unmatched' },
        el('strong', { text: `Zotero에서 단 메모 (p.${page}, 위치를 찾지 못함)` }),
        el('ul', {}, list.map((z) => el('li', {}, '🟡 ', z.text, z.comment ? el('em', { text: ` — ${z.comment}` }) : null))));
      if (at !== -1 && next) body.insertBefore(box, next); else body.append(box);
      extras.push(box);
    }
  }

  // ----- popover -----
  function closePopover() {
    s.pop?.remove();
    s.pop = null;
    s.popover = null;
  }

  function place(node, rect) {
    node.style.top = `${Math.max(8, Math.min(window.innerHeight - node.offsetHeight - 8, rect.bottom + 6))}px`;
    node.style.left = `${Math.max(8, Math.min(window.innerWidth - node.offsetWidth - 8, rect.left))}px`;
  }

  function replaceHighlight(rec) {
    const list = s.notes.highlights;
    const i = list.findIndex((h) => h.id === rec.id);
    if (i === -1) list.push(rec); else list[i] = rec;
    renderMarks();
  }

  const sentEl = (sid) => panel.querySelector(`[data-sid="${CSS.escape(sid)}"]`);

  function openPopover(sid, anchor, focusText = false) {
    if (s.disposed) return;
    closePopover();
    const marks = (sentenceMarks(s.notes).get(sid) ?? []);
    const parts = [];
    for (const m of marks) {
      if (m.kind === 'mine') {
        const h = s.notes.highlights.find((x) => x.id === m.hid);
        if (h) parts.push(minePart(h, focusText));
      } else {
        const z = s.notes.zoteroAnnotations.find((x) => x.key === m.key);
        if (z) parts.push(el('section', { class: 'pop-sec' },
          el('strong', { text: 'Zotero에서 단 메모' }),
          z.comment ? el('p', { text: z.comment }) : el('p', { class: 'muted', text: '(메모 없음)' }),
          el('p', { class: 'muted', text: '읽기 전용입니다. Zotero에서 고칠 수 있습니다.' })));
      }
    }
    if (!parts.length) return;
    const pop = el('div', { class: 'note-pop', role: 'dialog', 'aria-label': '메모' }, parts,
      el('button', { type: 'button', class: 'btn btn-quiet', text: '닫기', 'aria-label': '메모 창 닫기', onclick: closePopover }));
    s.pop = pop;
    s.popover = sid;
    document.body.append(pop);
    place(pop, anchor.getBoundingClientRect());
    (pop.querySelector('textarea') ?? pop.querySelector('button'))?.focus({ preventScroll: true });
  }

  function minePart(h, focusText) {
    const area = el('textarea', { rows: 3, 'aria-label': '메모', placeholder: '메모를 입력하세요' });
    area.value = h.comment ?? '';
    const put = async (patch) => {
      try { replaceHighlight(await actions.updateHighlight(id, h.id, patch)); return true; } catch (e) { fail(e); return false; }
    };
    const remove = async () => {
      try {
        await actions.removeHighlight(id, h.id);
        s.notes.highlights = s.notes.highlights.filter((x) => x.id !== h.id);
        closePopover();
        renderMarks();
      } catch (e) { fail(e); }
    };
    // Re-sending the same values clears the conflict and queues an upsert (recreates if unlinked).
    const ack = async () => { const sid = s.popover; if (await put({ color: h.color, comment: h.comment ?? '' })) openPopover(sid, sentEl(sid) ?? panel, false); };
    const cv = conflictView(h.conflict);
    const conflictButtons = {
      dismiss: () => el('button', { type: 'button', class: 'btn btn-quiet', text: '닫기', 'aria-label': '충돌 안내 닫기', onclick: ack }),
      resend: () => el('button', { type: 'button', class: 'btn', text: '다시 보내기', 'aria-label': 'Zotero로 다시 보내기', onclick: ack }),
      delete: () => el('button', { type: 'button', class: 'btn btn-quiet', text: '삭제', 'aria-label': '이 컴퓨터에서 하이라이트 삭제', onclick: remove }),
    };
    return el('section', { class: 'pop-sec' },
      cv ? el('div', { class: 'conflict', role: 'alert' },
        el('span', { text: cv.text }),
        el('div', { class: 'pop-actions' }, cv.actions.map((a) => conflictButtons[a]()))) : null,
      area,
      swatches(h.color, async (color) => { if (await put({ color })) h.color = color; }),
      el('div', { class: 'pop-actions' },
        el('button', { type: 'button', class: 'btn', text: '저장', 'aria-label': '메모 저장',
          onclick: async () => { if (await put({ comment: area.value })) closePopover(); } }),
        el('button', { type: 'button', class: 'btn btn-quiet', text: '삭제', 'aria-label': '하이라이트 삭제', onclick: remove })));
  }

  // ----- selection toolbar -----
  function readSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!panel.contains(range.commonAncestorContainer)) return null;
    const hit = [...panel.querySelectorAll('.sent')].filter((n) => range.intersectsNode(n) && n.getClientRects().length);
    if (!hit.length) return null;
    const a = sentOf(sel.anchorNode)?.dataset.sid ?? hit[0].dataset.sid;
    const f = sentOf(sel.focusNode)?.dataset.sid ?? hit[hit.length - 1].dataset.sid;
    const ids = selectionSentenceIds(order, a, f);
    if (!ids.length) return null;
    const rects = range.getClientRects();
    return { ids, rect: rects[rects.length - 1] ?? range.getBoundingClientRect(), pages: new Set(ids.map((x) => pageOf.get(x))) };
  }

  const create = singleFlight(async (withMemo) => {
    const sel = s.sel;
    if (!sel) return;
    try {
      const rec = await actions.addHighlight(id, { sentenceIds: sel.ids, color: s.color });
      if (s.disposed) return;
      document.getSelection()?.removeAllRanges();
      hideToolbar();
      replaceHighlight(rec);
      if (withMemo) openPopover(rec.sentenceIds[0], sentEl(rec.sentenceIds[0]) ?? panel, true);
    } catch (e) { if (!s.disposed) fail(e); }
  });

  function hideToolbar() { toolbar.hidden = true; s.sel = null; }

  function renderToolbar() {
    if (s.disposed) return;
    const sel = readSelection();
    s.sel = sel;
    if (!sel) { toolbar.hidden = true; return; }
    const multi = sel.pages.size > 1;
    const stop = (e) => e.preventDefault();
    toolbar.replaceChildren(...(s.notes?.needsReextract
      ? [el('span', { class: 'sel-msg', text: `원문을 다시 추출해야 합니다: npm run extract -- ${id}` })]
      : multi
        ? [el('span', { class: 'sel-msg', text: MULTI_PAGE_TEXT })]
        : [
          el('button', { type: 'button', class: 'btn', text: '🖍 하이라이트', 'aria-label': '하이라이트 (h)', onmousedown: stop, onclick: () => create(false) }),
          el('button', { type: 'button', class: 'btn', text: '📝 메모', 'aria-label': '메모 (m)', onmousedown: stop, onclick: () => create(true) }),
          swatches(s.color, (c) => { s.color = c; renderToolbar(); }),
        ]));
    toolbar.hidden = false;
    place(toolbar, sel.rect);
  }

  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderToolbar); };
  const onSelChange = schedule;
  const onPanelClick = (e) => {
    const n = sentOf(e.target);
    if (!n || !document.getSelection()?.isCollapsed) return;
    if (sentenceMarks(s.notes).has(n.dataset.sid)) openPopover(n.dataset.sid, n);
  };
  const onPanelKey = (e) => {
    const n = sentOf(e.target);
    if ((e.key === 'Enter' || e.key === ' ') && n?.getAttribute('role') === 'button') { e.preventDefault(); openPopover(n.dataset.sid, n); }
  };
  const onDocKey = (e) => {
    if (e.key === 'Escape' && s.pop) { closePopover(); return; }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || !s.sel || s.notes?.needsReextract || s.sel.pages.size > 1) return;
    if (e.key === 'h') { e.preventDefault(); create(false); } else if (e.key === 'm') { e.preventDefault(); create(true); }
  };
  const onDocDown = (e) => {
    if (s.pop && !s.pop.contains(e.target) && !sentOf(e.target)) closePopover();
  };
  document.addEventListener('selectionchange', onSelChange);
  panel.addEventListener('mouseup', schedule);
  panel.addEventListener('keyup', schedule);
  panel.addEventListener('click', onPanelClick);
  panel.addEventListener('keydown', onPanelKey);
  document.addEventListener('keydown', onDocKey);
  document.addEventListener('mousedown', onDocDown);

  // ----- polling -----
  let timer = 0;
  let inflight = false;
  async function poll() {
    if (s.disposed || inflight || document.hidden) return;
    inflight = true;
    try {
      const n = await actions.notes(id);
      const json = JSON.stringify(n);
      if (s.disposed) return;
      if (json !== s.lastJson) {
        s.lastJson = json;
        s.notes = n;
        renderStatus();
        renderMarks();
        onNotes?.(n);
        if (s.popover && !(sentenceMarks(n).has(s.popover))) closePopover();
        if (s.sel) renderToolbar();
      }
    } catch { /* keep the last good state; the next tick retries */ } finally { inflight = false; }
  }
  const tick = async () => { await poll(); if (!s.disposed) timer = setTimeout(tick, POLL_MS); };
  const onVis = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', onVis);
  tick();

  return {
    statusNode,
    refresh: poll,
    dispose() {
      s.disposed = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('keydown', onDocKey);
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('visibilitychange', onVis);
      closePopover();
      toolbar.remove();
    },
  };
}
