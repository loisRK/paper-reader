// Highlights and memos on the source panel. Pure helpers are tested in Node;
// the DOM pieces only touch `document` when called.
import { el, setChildren } from './dom.js';
import { matchRects, clientRectsToPdf, pdfRectToCss, sentenceAtPoint } from './pdf-geom.js';

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
const EXAMPLE_TEXT = '예제 논문에는 메모를 저장하지 않습니다.';

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

// Concurrent calls share one run. The slot is cleared after the run settles, even when fn
// finishes without awaiting (a `x ??= (async () => { finally { x = null } })()` pattern would
// re-store the settled promise after the finally and return it forever).
export function sharedFlight(fn) {
  let running = null;
  return () => {
    if (running) return running;
    const p = (async () => fn())();
    running = p;
    const clear = () => { if (running === p) running = null; };
    p.then(clear, clear);
    return p;
  };
}

export function statusText(status, pending) {
  switch (status) {
    case 'connected': return 'Zotero 연결됨';
    case 'offline': return `Zotero 연결 대기 중 (보낼 메모 ${pending ?? 0}개)`;
    case 'needs-auth':
    case 'denied': return 'Zotero 쓰기 허용이 필요합니다';
    case 'rate-limited': return 'Zotero 허용 요청이 많아 잠시 후 다시 시도합니다';
    case 'example': return EXAMPLE_TEXT;
    default: return READONLY_TEXT;
  }
}

// The popover's textarea holds an edit that is not saved yet.
export const needsCommentSave = (original, current) => typeof current === 'string' && current !== (original ?? '');

// What a mousedown does to an open popover.
// 'keep': inside the popover (or nothing open). 'reopen': another marked sentence (its click opens it).
// 'close': anywhere else — including unmarked text and the sentence whose popover is already open (toggle).
export function popoverDownAction({ open, inPopover, sid, marked, openSid }) {
  if (!open || inPopover) return 'keep';
  if (sid && marked && sid !== openSid) return 'reopen';
  return 'close';
}

// One polling chain: kick() runs now and reschedules; a kick during a run (e.g. the tab became
// visible again) supersedes the older chain instead of starting a second one.
export function createPoller({ run, ms, setTimeout: st = globalThis.setTimeout, clearTimeout: ct = globalThis.clearTimeout }) {
  let timer = null;
  let gen = 0;
  let stopped = false;
  async function kick() {
    if (stopped) return;
    const g = ++gen;
    if (timer !== null) { ct(timer); timer = null; }
    try {
      await run();
    } finally {
      if (!stopped && g === gen) timer = st(kick, ms);
    }
  }
  return {
    kick,
    stop() { stopped = true; if (timer !== null) ct(timer); timer = null; },
  };
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

// ----- PDF view -----

// Selection on the PDF text layer, as PDF rects per page -> sentence ids (page order, then
// sentence order) and the pages that actually matched. The match rule is pdf-geom's matchRects,
// the same one Zotero annotations go through.
export function pdfSelectionResult({ pageRects, source }) {
  const ids = [];
  const pages = new Set();
  const entries = [...(pageRects instanceof Map ? pageRects : [])].sort((a, b) => a[0] - b[0]);
  for (const [page, rects] of entries) {
    const hit = matchRects(rects, page, source);
    if (!hit.length) continue;
    pages.add(page);
    ids.push(...hit);
  }
  return { ids, pages };
}

// What the PDF view draws for the notes: my highlights per sentence (their colour), and Zotero
// annotations as their stored rects (old data without rects: the matched sentences' pdfRects).
export function pdfMarkLayers(notes, source) {
  const marks = new Map();
  for (const h of notes?.highlights ?? []) {
    for (const sid of h.sentenceIds ?? []) if (!marks.has(sid)) marks.set(sid, { color: h.color });
  }
  const zoteroRects = [];
  for (const z of notes?.zoteroAnnotations ?? []) {
    let rects = Array.isArray(z.rects) ? z.rects : [];
    let page = z.page;
    if (!rects.length) {
      const sents = (z.sentenceIds ?? []).map((sid) => source?.sentences?.[sid]).filter((x) => Array.isArray(x?.pdfRects));
      rects = sents.flatMap((x) => x.pdfRects);
      page = Number.isInteger(page) && page > 0 ? page : sents[0]?.page;
    }
    if (rects.length && Number.isInteger(page)) zoteroRects.push({ page, rects, color: z.color });
  }
  return { marks, zoteroRects };
}

// Client point (x, y) on a PDF page -> the marked sentence under it (only among `sids`), or null.
export function pdfPointSentence({ x, y, pageBox, viewport, page, source, sids }) {
  const [px, py] = viewport.convertToPdfPoint(x - pageBox.left, y - pageBox.top);
  return sentenceAtPoint(px, py, page, source, sids ?? []);
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
// pdf (optional): { view: () => createPdfView handle | null, pane: the PDF tab panel inside `panel` }.
// Returns { statusNode, refresh, pdfChanged, dispose } — call pdfChanged() once a PDF view exists.
export function setupNotes({ id, source, panel, actions, onNotes, example = false, pdf = null }) {
  // Example papers never store memos (writes are 403): one static line, no badge, no
  // authorize button, no re-extract hint, no selection toolbar, no polling.
  if (example) {
    const statusNode = el('div', { class: 'notes-status st-example', role: 'status' },
      el('span', { class: 'muted st-hint', text: statusText('example') }));
    return { statusNode, refresh: async () => {}, pdfChanged() {}, dispose() {} };
  }
  const order = [];
  const pageOf = new Map();
  for (const b of source.blocks ?? []) {
    for (const sid of b.sentenceIds ?? []) { order.push(sid); pageOf.set(sid, b.page); }
  }
  const s = { notes: emptyNotes(), lastJson: null, color: DEFAULT_COLOR, popover: null, pop: null, edits: [], sel: null, disposed: false };
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
    setChildren(statusNode,
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
    renderPdfMarks();
  }

  // ----- the same notes on the PDF view -----
  const pdfView = () => pdf?.view?.() ?? null;
  const pdfShown = () => Boolean(pdf && !pdf.pane.hidden && pdfView());
  function renderPdfMarks() {
    const v = pdfView();
    if (!v) return;
    const { marks, zoteroRects } = pdfMarkLayers(s.notes, source);
    v.setMarks(marks, zoteroRects);
  }
  // Client rect of a sentence's first PDF rect (where its popover goes), or null.
  function pdfSentenceRect(sid) {
    const sent = source.sentences?.[sid];
    const r0 = Array.isArray(sent?.pdfRects) ? sent.pdfRects[0] : null;
    const layer = r0 ? pdfView()?.pageLayer(sent.page) : null;
    if (!layer?.viewport) return null;
    const box = layer.el.getBoundingClientRect();
    const c = pdfRectToCss(r0, layer.viewport);
    const left = box.left + c.left;
    const top = box.top + c.top;
    return { left, top, right: left + c.width, bottom: top + c.height, width: c.width, height: c.height };
  }
  // The marked sentence under a client point on a PDF page, or null.
  function pdfHit(target, x, y) {
    const pageEl = target instanceof Element ? target.closest('.pdf-page') : null;
    if (!pageEl || !pdf?.pane.contains(pageEl)) return null;
    const page = Number(pageEl.dataset.page);
    const layer = pdfView()?.pageLayer(page);
    if (!layer?.viewport) return null;
    return pdfPointSentence({
      x, y, pageBox: pageEl.getBoundingClientRect(), viewport: layer.viewport, page, source,
      sids: [...sentenceMarks(s.notes).keys()],
    });
  }

  // ----- popover -----
  function removePopover() {
    s.pop?.remove();
    s.pop = null;
    s.popover = null;
    s.edits = [];
  }
  const unsavedEdits = () => s.edits.filter((e) => needsCommentSave(e.original, e.area.value));

  // Saves typed memo text first; on failure (toast) the popover stays open with the text.
  // Resolves true when closed.
  const closeRun = sharedFlight(async () => {
    if (!s.pop) return true;
    for (const e of unsavedEdits()) {
      const value = e.area.value;
      if (!(await e.put({ comment: value }))) return false;
      e.original = value;
    }
    removePopover();
    return true;
  });
  const closePopover = () => (s.pop ? closeRun() : Promise.resolve(true));

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

  const sentEl = (sid) => panel.querySelector(`.sent[data-sid="${CSS.escape(sid)}"]`);
  // Where a sentence's popover goes in the view that is showing: an element or a client rect.
  const anchorOf = (sid) => (pdfShown() ? pdfSentenceRect(sid) : sentEl(sid)) ?? panel;

  async function openPopover(sid, anchor, focusText = false) {
    if (s.disposed) return;
    if (!(await closePopover()) || s.disposed) return;
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
      el('button', { type: 'button', class: 'btn btn-quiet', text: '닫기', 'aria-label': '메모 창 닫기', onclick: () => closePopover() }));
    s.pop = pop;
    s.popover = sid;
    document.body.append(pop);
    place(pop, typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : anchor);
    (pop.querySelector('textarea') ?? pop.querySelector('button'))?.focus({ preventScroll: true });
  }

  function minePart(h, focusText) {
    const area = el('textarea', { rows: 3, 'aria-label': '메모', placeholder: '메모를 입력하세요' });
    area.value = h.comment ?? '';
    const put = async (patch) => {
      try { replaceHighlight(await actions.updateHighlight(id, h.id, patch)); return true; } catch (e) { fail(e); return false; }
    };
    const edit = { area, original: h.comment ?? '', put };
    s.edits.push(edit);
    const remove = async () => {
      try {
        await actions.removeHighlight(id, h.id);
        s.notes.highlights = s.notes.highlights.filter((x) => x.id !== h.id);
        s.edits = s.edits.filter((x) => x !== edit);
        await closePopover();
        renderMarks();
      } catch (e) { fail(e); }
    };
    // Re-sending the same values clears the conflict and queues an upsert (recreates if unlinked).
    const cur = () => s.notes.highlights.find((x) => x.id === h.id) ?? h;
    const ack = async () => { const sid = s.popover; const c = cur(); if (await put({ color: c.color, comment: c.comment ?? '' })) openPopover(sid, anchorOf(sid), false); };
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
      swatches(h.color, async (color) => { await put({ color }); }),
      el('div', { class: 'pop-actions' },
        el('button', { type: 'button', class: 'btn', text: '저장', 'aria-label': '메모 저장',
          onclick: async () => { const value = area.value; if (await put({ comment: value })) { edit.original = value; closePopover(); } } }),
        el('button', { type: 'button', class: 'btn btn-quiet', text: '삭제', 'aria-label': '하이라이트 삭제', onclick: remove })));
  }

  // ----- selection toolbar -----
  function readSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (pdf?.pane.contains(range.commonAncestorContainer)) return readPdfSelection(range);
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

  // Selection on the PDF text layer: the selected characters' client rects, per page, in PDF
  // coordinates -> sentences (pdfSelectionResult). Only text nodes are measured: a range's own
  // getClientRects() would also return the box of every element it fully contains (a whole page).
  function readPdfSelection(range) {
    const v = pdfShown() ? pdfView() : null;
    if (!v) return null;
    const root = range.commonAncestorContainer;
    const texts = [];
    if (root.nodeType === 3) texts.push(root);
    else {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) if (range.intersectsNode(t)) texts.push(t);
    }
    const byPage = new Map();
    let last = null;
    for (const t of texts) {
      const pageEl = t.parentElement?.closest('.textLayer')?.closest('.pdf-page');
      if (!pageEl) continue;
      const r = document.createRange();
      r.selectNodeContents(t);
      if (t === range.startContainer) r.setStart(t, range.startOffset);
      if (t === range.endContainer) r.setEnd(t, range.endOffset);
      if (!r.toString().trim()) continue;
      const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
      if (!rects.length) continue;
      const page = Number(pageEl.dataset.page);
      byPage.set(page, [...(byPage.get(page) ?? []), ...rects]);
      last = rects[rects.length - 1];
    }
    if (!byPage.size) return null;
    const pageRects = new Map();
    for (const [page, rects] of byPage) {
      const layer = v.pageLayer(page);
      if (layer?.viewport) pageRects.set(page, clientRectsToPdf(rects, layer.el.getBoundingClientRect(), layer.viewport));
    }
    const { ids, pages } = pdfSelectionResult({ pageRects, source });
    // Old extraction (no pdfRects): nothing can match, but say why instead of showing nothing.
    if (s.notes?.needsReextract) return { ids, rect: last, pages: new Set(byPage.keys()) };
    return ids.length ? { ids, rect: last, pages } : null;
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
      if (withMemo) openPopover(rec.sentenceIds[0], anchorOf(rec.sentenceIds[0]), true);
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
  // A mousedown that closed this sentence's popover must not reopen it on the following click.
  let toggledClosed = null;
  const onPanelClick = (e) => {
    const n = sentOf(e.target);
    const sid = n?.dataset.sid ?? pdfHit(e.target, e.clientX, e.clientY);
    const skip = toggledClosed;
    toggledClosed = null;
    if (!sid || !document.getSelection()?.isCollapsed || sid === skip) return;
    if (sentenceMarks(s.notes).has(sid)) openPopover(sid, n ?? anchorOf(sid));
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
    const n = sentOf(e.target);
    const sid = n?.dataset.sid ?? pdfHit(e.target, e.clientX, e.clientY);
    const action = popoverDownAction({
      open: Boolean(s.pop), inPopover: Boolean(s.pop?.contains(e.target)),
      sid, marked: Boolean(sid && sentenceMarks(s.notes).has(sid)), openSid: s.popover,
    });
    if (action !== 'close') return;
    if (sid && sid === s.popover) toggledClosed = sid;
    closePopover();
  };
  document.addEventListener('selectionchange', onSelChange);
  panel.addEventListener('mouseup', schedule);
  panel.addEventListener('keyup', schedule);
  panel.addEventListener('click', onPanelClick);
  panel.addEventListener('keydown', onPanelKey);
  document.addEventListener('keydown', onDocKey);
  document.addEventListener('mousedown', onDocDown);

  // ----- polling -----
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
        // Highlight gone: close, unless typed text is unsaved (left open so it is not lost).
        if (s.popover && !(sentenceMarks(n).has(s.popover)) && !unsavedEdits().length) removePopover();
        if (s.sel) renderToolbar();
      }
    } catch { /* keep the last good state; the next tick retries */ } finally { inflight = false; }
  }
  const poller = createPoller({ run: poll, ms: POLL_MS });
  const onVis = () => { if (!document.hidden) poller.kick(); };
  document.addEventListener('visibilitychange', onVis);
  poller.kick();

  return {
    statusNode,
    refresh: poll,
    pdfChanged: renderPdfMarks,
    dispose() {
      s.disposed = true;
      poller.stop();
      cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('keydown', onDocKey);
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('visibilitychange', onVis);
      // Leaving the page: send unsaved popover text without waiting.
      for (const e of unsavedEdits()) e.put({ comment: e.area.value });
      removePopover();
      toolbar.remove();
    },
  };
}
