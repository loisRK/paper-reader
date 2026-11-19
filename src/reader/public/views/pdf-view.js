// PDF view for the source panel: PDF.js rendering, lazy pages, zoom, scroll + evidence flash.
// PDF.js is imported dynamically the first time a view is created (text-only readers never load it).
// Pure helpers at the top are tested in Node; nothing touches the DOM at import time.
import { el } from './dom.js';
import { pdfRectToCss } from './pdf-geom.js';

const VENDOR = '/vendor/pdfjs/';
const CSS_UNITS = 96 / 72; // PDF points -> CSS px at 100%
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
const FIT_MIN = 0.25; // fit may go below the button range on a narrow phone
const MAX_CANVAS_PIXELS = 16_777_216;
const FLASH_MS = 1600;
const EPS = 1e-6;

// ---------- pure helpers ----------

const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
const tenth = (z) => Math.round(z * 10) / 10;

// Next zoom on the 0.1 grid (an off-grid fit value snaps to the neighbouring step), 50%–300%.
export function nextZoom(current, dir) {
  const t = current * 10;
  const z = dir === 'in' ? Math.floor(t + EPS) / 10 + 0.1 : Math.ceil(t - EPS) / 10 - 0.1;
  return tenth(clampZoom(tenth(z)));
}

// Visible pages ±1, inside 1..numPages, ascending.
export function pagesToDraw(visible, numPages) {
  const out = new Set();
  for (const p of visible) for (const q of [p - 1, p, p + 1]) if (q >= 1 && q <= numPages) out.add(q);
  return new Set([...out].sort((a, b) => a - b));
}

// ---------- view ----------

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import(`${VENDOR}pdf.min.mjs`).then((m) => {
    m.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;
    return m;
  }).catch((e) => { pdfjsPromise = null; throw e; });
  return pdfjsPromise;
}

async function fetchPdf(paperId) {
  const res = await fetch(`/api/papers/${encodeURIComponent(paperId)}/pdf`);
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.error || `서버 응답 ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// container: an empty element the view fills (toolbar + scrolling pages).
// onError(err): document could not be opened (err.message is a Korean reason).
export function createPdfView({ paperId, source, container, onError }) {
  const sentences = source?.sentences ?? {};
  const st = {
    disposed: false,
    pdf: null,
    task: null, // PDF.js loading task (PDFDocumentProxy has no destroy() in 6.x)
    pdfjs: null,
    pages: [], // index page-1 -> { num, proxy, el, canvas, marks, text, viewport, drawn, task, textTask }
    zoom: 1,
    fit: true,
    visible: new Set(),
    pending: null, // action queued until the document is laid out
    marks: new Map(),
    zoteroRects: [],
    evidence: [],
    flashTimer: 0,
  };

  const zoomLabel = el('span', { class: 'pdf-zoom-label', 'aria-live': 'polite', text: '' });
  const pageLabel = el('span', { class: 'pdf-page-label muted', text: '' });
  const btn = (text, label, onclick) => el('button', { type: 'button', class: 'btn btn-quiet pdf-zoom-btn', 'aria-label': label, title: label, text, onclick });
  const toolbar = el('div', { class: 'pdf-toolbar', role: 'toolbar', 'aria-label': 'PDF 확대' },
    btn('−', '축소', () => zoom('out')),
    btn('맞춤', '패널 폭에 맞춤', () => zoom('fit')),
    btn('+', '확대', () => zoom('in')),
    zoomLabel,
    pageLabel,
  );
  const status = el('p', { class: 'pdf-status muted', role: 'status', text: 'PDF를 여는 중…' });
  const pagesEl = el('div', { class: 'pdf-pages' });
  const scroller = el('div', { class: 'pdf-scroll', tabindex: 0, 'aria-label': 'PDF 쪽' }, status, pagesEl);
  container.replaceChildren(toolbar, scroller);

  // ----- layout -----
  const scaleOf = () => st.zoom * CSS_UNITS;

  function fitZoom() {
    const first = st.pages[0];
    const avail = scroller.clientWidth - 24; // page margin on both sides
    if (!first || avail <= 0) return null;
    const w = first.proxy.getViewport({ scale: CSS_UNITS }).width;
    return Math.min(ZOOM_MAX, Math.max(FIT_MIN, avail / w));
  }

  function sizePages() {
    const scale = scaleOf();
    for (const p of st.pages) {
      p.viewport = p.proxy.getViewport({ scale });
      p.el.style.width = `${Math.floor(p.viewport.width)}px`;
      p.el.style.height = `${Math.floor(p.viewport.height)}px`;
      p.el.style.setProperty('--scale-factor', String(scale));
    }
    zoomLabel.textContent = `${Math.round(st.zoom * 100)}%`;
    drawAllMarks(false);
  }

  // ----- drawing -----
  function release(p) {
    p.task?.cancel();
    p.textTask?.cancel();
    p.task = null;
    p.textTask = null;
    p.canvas.width = 0;
    p.canvas.height = 0;
    p.text.replaceChildren();
    p.drawn = false;
    p.el.classList.remove('is-drawn');
  }

  async function draw(p) {
    if (p.drawn) return;
    p.drawn = true;
    const { viewport } = p;
    let dpr = window.devicePixelRatio || 1;
    const area = viewport.width * viewport.height;
    if (area * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / area);
    p.canvas.width = Math.floor(viewport.width * dpr);
    p.canvas.height = Math.floor(viewport.height * dpr);
    const task = p.proxy.render({
      canvas: p.canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    p.task = task;
    p.text.replaceChildren();
    const textTask = new st.pdfjs.TextLayer({
      textContentSource: p.proxy.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: p.text,
      viewport,
    });
    p.textTask = textTask;
    try {
      await Promise.all([task.promise, textTask.render()]);
      if (p.task === task) p.el.classList.add('is-drawn');
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException' && e?.name !== 'AbortException' && !st.disposed) {
        console.warn(`PDF ${p.num}쪽을 그리지 못했습니다:`, e);
      }
    } finally {
      if (p.task === task) p.task = null;
      if (p.textTask === textTask) p.textTask = null;
    }
  }

  function update() {
    if (st.disposed || !st.pages.length) return;
    const want = pagesToDraw(st.visible, st.pages.length);
    const keep = pagesToDraw(want, st.pages.length); // hysteresis: release only pages 2+ away
    for (const p of st.pages) {
      if (want.has(p.num)) draw(p);
      else if (p.drawn && !keep.has(p.num)) release(p);
    }
    const top = [...st.visible].sort((a, b) => a - b)[0];
    if (top) pageLabel.textContent = `${top} / ${st.pages.length}쪽`;
  }

  let io = null;
  let ro = null;

  // ----- marks / evidence / flash -----
  const sentRects = (sid) => {
    const s = sentences[sid];
    return s && Number.isInteger(s.page) && Array.isArray(s.pdfRects) ? s.pdfRects.map((r) => ({ page: s.page, rect: r })) : [];
  };
  function box(p, rect, cls) {
    const c = pdfRectToCss(rect, p.viewport);
    const d = el('div', { class: cls });
    Object.assign(d.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` });
    return d;
  }
  // keepFlash=false after a zoom: flash boxes were placed for the old viewport.
  function drawAllMarks(keepFlash = true) {
    if (!st.pages.length) return;
    const byPage = new Map(st.pages.map((p) => [p.num, []]));
    const add = (page, node) => byPage.get(page)?.push(node);
    const pageOf = (n) => st.pages[n - 1];
    for (const sid of st.evidence) {
      for (const { page, rect } of sentRects(sid)) if (pageOf(page)) add(page, box(pageOf(page), rect, 'pdf-ev'));
    }
    for (const [sid, m] of st.marks) {
      for (const { page, rect } of sentRects(sid)) {
        if (!pageOf(page)) continue;
        const d = box(pageOf(page), rect, `pdf-mark${m?.color ? ' pdf-mark-mine' : ''}${m?.zotero ? ' pdf-mark-zot' : ''}`);
        d.dataset.markSid = sid; // not data-sid: notes.js looks up .sent[data-sid] in the same panel
        if (m?.color) d.style.setProperty('--mark', m.color);
        add(page, d);
      }
    }
    for (const z of st.zoteroRects) {
      if (!pageOf(z?.page)) continue;
      for (const rect of z.rects ?? []) {
        const d = box(pageOf(z.page), rect, 'pdf-mark pdf-mark-zotrect');
        if (z.color) d.style.setProperty('--mark', z.color);
        add(z.page, d);
      }
    }
    for (const p of st.pages) {
      const flashes = keepFlash ? [...p.marks.querySelectorAll('.pdf-flash')] : [];
      p.marks.replaceChildren(...byPage.get(p.num), ...flashes);
    }
  }

  function flash(rects) {
    clearTimeout(st.flashTimer);
    for (const n of pagesEl.querySelectorAll('.pdf-flash')) n.remove();
    for (const { page, rect } of rects) {
      const p = st.pages[page - 1];
      if (p) p.marks.append(box(p, rect, 'pdf-flash'));
    }
    st.flashTimer = setTimeout(() => { for (const n of pagesEl.querySelectorAll('.pdf-flash')) n.remove(); }, FLASH_MS);
  }

  // Scroll so that point (x, y) in page CSS px sits at the centre (vertically) of the scroller.
  function scrollToPoint(p, x, y, smooth) {
    const sr = scroller.getBoundingClientRect();
    const pr = p.el.getBoundingClientRect();
    const top = scroller.scrollTop + (pr.top - sr.top) + y - scroller.clientHeight / 2;
    const left = scroller.scrollLeft + (pr.left - sr.left) + x - scroller.clientWidth / 2;
    scroller.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
  }

  function whenReady(fn) {
    if (st.pages.length) fn();
    else st.pending = fn;
  }

  // ----- public API -----
  function scrollToPage(page) {
    whenReady(() => {
      const p = st.pages[Math.min(Math.max(1, Math.round(page) || 1), st.pages.length) - 1];
      const sr = scroller.getBoundingClientRect();
      const pr = p.el.getBoundingClientRect();
      scroller.scrollTo({ top: scroller.scrollTop + pr.top - sr.top - 8, behavior: reduceMotion() ? 'auto' : 'smooth' });
    });
  }

  function scrollToSentences(sids) {
    const ids = (Array.isArray(sids) ? sids : []).filter((sid) => sentences[sid]);
    const rects = ids.flatMap(sentRects);
    const page = rects[0]?.page ?? ids.map((sid) => sentences[sid].page).find(Number.isInteger);
    if (!page || (st.pdf && page > st.pages.length)) return false;
    whenReady(() => {
      const p = st.pages[page - 1];
      if (!p) return;
      if (!rects.length) { scrollToPage(page); return; }
      const c = pdfRectToCss(rects[0].rect, p.viewport);
      scrollToPoint(p, c.left + c.width / 2, c.top + c.height / 2, true);
      flash(rects);
    });
    return true;
  }

  function setMarks(marks, zoteroRects) {
    st.marks = marks instanceof Map ? marks : new Map();
    st.zoteroRects = Array.isArray(zoteroRects) ? zoteroRects : [];
    drawAllMarks();
  }

  function setEvidence(sids) {
    st.evidence = Array.isArray(sids) ? [...sids] : [];
    drawAllMarks();
  }

  // Keeps the page at the top of the panel (and the offset into it) in place across a zoom change.
  function zoom(dir) {
    if (!st.pages.length) return;
    let target = dir === 'fit' ? fitZoom() : nextZoom(st.zoom, dir);
    if ((dir === 'out' && target > st.zoom) || (dir === 'in' && target < st.zoom)) target = st.zoom; // below 50% after fit
    if (dir === 'fit' || target !== st.zoom) st.fit = dir === 'fit';
    if (target === null || Math.abs(target - st.zoom) < EPS) { zoomLabel.textContent = `${Math.round(st.zoom * 100)}%`; return; }
    const sr = scroller.getBoundingClientRect();
    const anchor = st.pages.find((p) => p.el.getBoundingClientRect().bottom > sr.top) ?? st.pages[0];
    const ar = anchor.el.getBoundingClientRect();
    const fracY = (sr.top - ar.top) / ar.height;
    const fracX = scroller.scrollWidth > scroller.clientWidth ? (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth : 0.5;
    st.zoom = target;
    for (const p of st.pages) if (p.drawn) release(p);
    sizePages();
    const nr = anchor.el.getBoundingClientRect();
    scroller.scrollTop += (nr.top - sr.top) + fracY * nr.height;
    scroller.scrollLeft = Math.max(0, fracX * scroller.scrollWidth - scroller.clientWidth / 2);
    update();
  }

  function pageLayer(page) {
    const p = st.pages[page - 1];
    return p ? { el: p.el, viewport: p.viewport, textLayer: p.text, marks: p.marks, drawn: p.el.classList.contains('is-drawn') } : null;
  }

  function dispose() {
    st.disposed = true;
    clearTimeout(st.flashTimer);
    io?.disconnect();
    ro?.disconnect();
    for (const p of st.pages) release(p);
    st.task?.destroy().catch(() => {});
    container.replaceChildren();
  }

  // ----- open -----
  const ready = (async () => {
    const [pdfjs, data] = await Promise.all([loadPdfjs(), fetchPdf(paperId)]);
    if (st.disposed) return;
    st.pdfjs = pdfjs;
    st.task = pdfjs.getDocument({
      data,
      standardFontDataUrl: `${VENDOR}standard_fonts/`,
      cMapUrl: `${VENDOR}cmaps/`,
      cMapPacked: true,
      wasmUrl: `${VENDOR}wasm/`,
    });
    const pdf = await st.task.promise;
    if (st.disposed) return;
    st.pdf = pdf;
    const proxies = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
    if (st.disposed) return;
    st.pages = proxies.map((proxy, i) => {
      const canvas = el('canvas', { 'aria-hidden': 'true', width: 0, height: 0 });
      const marks = el('div', { class: 'pdf-marks', 'aria-hidden': 'true' });
      const text = el('div', { class: 'textLayer' });
      const node = el('div', { class: 'pdf-page', dataset: { page: String(i + 1) }, 'aria-label': `${i + 1}쪽` }, canvas, marks, text);
      return { num: i + 1, proxy, el: node, canvas, marks, text, viewport: null, drawn: false, task: null, textTask: null };
    });
    status.remove();
    pagesEl.replaceChildren(...st.pages.map((p) => p.el));
    st.zoom = fitZoom() ?? 1;
    sizePages();
    // The vertical scrollbar appears only once pages have height: fit again against the narrower width.
    const refit = fitZoom();
    if (refit && Math.abs(refit - st.zoom) > EPS) { st.zoom = refit; sizePages(); }

    io = new IntersectionObserver((entries) => {
      // Tab hidden (display: none): keep what is drawn so switching back is instant.
      if (!scroller.clientHeight) return;
      for (const e of entries) {
        const n = Number(e.target.dataset.page);
        if (e.isIntersecting) st.visible.add(n); else st.visible.delete(n);
      }
      update();
    }, { root: scroller, rootMargin: '0px', threshold: 0 });
    for (const p of st.pages) io.observe(p.el);

    let rt = 0;
    let lastW = scroller.clientWidth;
    let shown = lastW > 0;
    ro = new ResizeObserver(() => {
      const w = scroller.clientWidth;
      // Tab shown again after display:none: observe afresh so the visible pages are re-reported at once.
      if (w && !shown) {
        io.disconnect();
        for (const p of st.pages) io.observe(p.el);
      }
      shown = w > 0;
      if (!w || w === lastW) return;
      lastW = w;
      clearTimeout(rt);
      rt = setTimeout(() => { if (st.fit && !st.disposed) zoom('fit'); }, 150);
    });
    ro.observe(scroller);

    const fn = st.pending;
    st.pending = null;
    fn?.();
  })();

  ready.catch((e) => {
    if (st.disposed) return;
    status.textContent = '';
    onError?.(e instanceof Error ? e : new Error(String(e)));
  });

  return { ready, scrollToSentences, scrollToPage, setMarks, setEvidence, zoom, pageLayer, dispose };
}
