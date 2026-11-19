import { el, clear, progressBar } from './dom.js';
import { setupNotes } from './notes.js';
import { setupCardMemos } from './card-memos.js';
import { createPdfView } from './pdf-view.js';
import { jobView, watchJob } from './digest.js';

const SECTION_LABELS = {
  motivation: '동기', gap: '빈틈(Gap)', idea: '아이디어', method: '방법', setup: '실험 설정',
  results: '결과', analysis: '분석', limits: '한계', implications: '시사점',
};
const MOBILE_QUERY = '(max-width: 959.98px)';
const TAB_KEY = 'paper-reader:source-tab';

// ---------- pure helpers (tested in Node) ----------

export function visibleItems(card, mode) {
  if (mode === '3min') return [];
  // Only the paper's own claims are shown; an old digest's opinion items never render.
  return Array.isArray(card?.items) ? card.items.filter((it) => it?.kind === 'claim') : [];
}

// Source panel tab on open: text when there is no PDF or the reader last chose text, else PDF.
export function initialSourceTab({ hasPdf, stored }) {
  if (!hasPdf) return 'text';
  return stored === 'text' ? 'text' : 'pdf';
}

export function sentenceHtmlId(sentenceId) {
  return `s-${sentenceId}`;
}

// Evidence sentence IDs of everything a card shows in the given mode.
export function cardEvidence(card, mode) {
  if (mode === '3min') return [];
  const ids = [];
  for (const it of visibleItems(card, mode)) ids.push(...(it.evidence ?? []));
  for (const b of card?.bigNumbers ?? []) ids.push(...(b.evidence ?? []));
  for (const t of card?.tables ?? []) ids.push(...(t.evidence ?? []));
  return [...new Set(ids)];
}

// Splits `text` into plain / glossary-term segments. Only the first occurrence of
// each term (tracked across calls via `seen`, keyed by lowercase term) is marked.
export function glossarySegments(text, glossary, seen) {
  const src = typeof text === 'string' ? text : '';
  if (!src) return [];
  const terms = (glossary ?? []).filter((g) => g && typeof g.term === 'string' && g.term.trim());
  const lower = src.toLowerCase();
  const out = [];
  let pos = 0;
  for (;;) {
    let best = null;
    for (const g of terms) {
      const key = g.term.toLowerCase();
      if (seen.has(key)) continue;
      const at = lower.indexOf(key, pos);
      if (at === -1) continue;
      if (!best || at < best.at || (at === best.at && key.length > best.key.length)) best = { at, key, g };
    }
    if (!best) break;
    if (best.at > pos) out.push({ text: src.slice(pos, best.at) });
    out.push({ text: src.slice(best.at, best.at + best.key.length), term: best.g.term, definition: best.g.definition ?? '' });
    seen.add(best.key);
    pos = best.at + best.key.length;
  }
  if (pos < src.length) out.push({ text: src.slice(pos) });
  return out;
}

export function figureSlug(label) {
  return String(label ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Card figure {label, page} → source.figures entry (same page preferred, else first label match).
export function findFigure(figures, f) {
  const hits = (Array.isArray(figures) ? figures : []).filter((x) => x && x.label === f?.label);
  return hits.find((x) => x.page === f?.page) ?? hits[0] ?? null;
}

// Unique DOM id per figure (aligned with `figures`): fig-p<page>-<slug>, -2/-3… on collision.
export function figureDomIds(figures) {
  const used = new Set();
  return (figures ?? []).map((f) => {
    const base = `fig-p${f?.page ?? 0}-${figureSlug(f?.label) || 'figure'}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

// blockId → { figure, role }. Only figures with an image take part; legacy extractions → empty Map.
// Every block gets at most one role; caption blocks are never folded.
export function figureLayout(source) {
  const out = new Map();
  const blocks = source?.blocks ?? [];
  const figs = (source?.figures ?? []).filter((f) => f?.image);
  const caps = new Map();
  for (const fig of figs) {
    const cap = blocks.find((b) => (b.sentenceIds ?? []).includes(fig.captionSentenceId));
    if (cap) caps.set(fig, cap);
  }
  const capIds = new Set([...caps.values()].map((c) => c.id));
  for (const fig of figs) {
    const cap = caps.get(fig);
    if (!cap || out.has(cap.id)) continue;
    out.set(cap.id, { figure: fig, role: 'image-before' });
    for (const id of fig.blockIds ?? []) if (!capIds.has(id) && !out.has(id)) out.set(id, { figure: fig, role: 'folded' });
  }
  return out;
}

// ---------- DOM ----------

function richText(text, glossary, seen) {
  return glossarySegments(text, glossary, seen).map((s) => (s.term
    ? el('abbr', { title: s.definition, text: s.text })
    : document.createTextNode(s.text)));
}

function evidenceButton(ids, onEvidence, cardId) {
  if (!ids?.length) return null;
  return el('button', {
    type: 'button',
    class: 'ev-btn',
    title: `원문 근거 보기 (${ids.join(', ')})`,
    'aria-label': `원문 근거 문장 ${ids.length}개 보기`,
    onclick: (e) => { e.stopPropagation(); onEvidence(ids, cardId); },
  }, '🔗');
}

function pageLink(page, links) {
  return links.zoteroPdf
    ? el('a', { href: `${links.zoteroPdf}?page=${page}`, text: `Zotero에서 p.${page} 열기` })
    : el('span', { class: 'muted', text: `p.${page}` });
}

function figureLine(f, links, onShow) {
  return el('li', { class: 'figure' },
    el('span', { class: 'figure-label', text: f.label || '그림' }),
    ' ',
    pageLink(f.page, links),
    onShow ? el('button', {
      type: 'button', class: 'btn btn-quiet fig-show', 'aria-label': `원문에서 ${f.label} 보기`,
      onclick: (e) => { e.stopPropagation(); onShow(f); },
    }, '원문에서 보기') : null,
    f.note ? el('span', { class: 'figure-note', text: ` — ${f.note}` }) : null,
  );
}

function tableNode(t, onEvidence, cardId) {
  return el('figure', { class: 'dtable' },
    el('div', { class: 'dtable-scroll' },
      el('table', {},
        t.title ? el('caption', {}, t.title, evidenceButton(t.evidence, onEvidence, cardId)) : null,
        el('thead', {}, el('tr', {}, t.columns.map((c) => el('th', { scope: 'col', text: c })))),
        el('tbody', {}, t.rows.map((r) => el('tr', {}, r.map((v, i) => (i === 0 ? el('th', { scope: 'row', text: v }) : el('td', { text: v })))))),
      ),
    ),
    t.note ? el('figcaption', { class: 'dtable-note', text: t.note }) : null,
  );
}

function sourcePanel(source, links, onClose, paperId) {
  const meta = source.meta ?? {};
  const authors = meta.authors ?? [];
  const sentences = source.sentences ?? {};
  const body = el('div', { class: 'source-body' });
  let lastPage = null;
  let refs = null;
  let refsCount = 0;

  const sentenceSpans = (ids) => ids.flatMap((sid) => {
    const s = sentences[sid];
    if (!s) return [];
    return [el('span', { class: 'sent', id: sentenceHtmlId(sid), dataset: { sid }, text: s.text }), ' '];
  });

  const layout = figureLayout(source);
  const allIds = figureDomIds(source.figures);
  const domIds = new Map((source.figures ?? []).map((f, i) => [f, allIds[i]]));
  const blockEl = (b) => {
    const ids = b.sentenceIds ?? [];
    if (b.type === 'heading') return el('h3', { class: 'src-heading' }, sentenceSpans(ids));
    if (b.type === 'caption') return el('p', { class: 'caption' }, sentenceSpans(ids));
    return el('p', { class: 'para' }, sentenceSpans(ids));
  };
  const blockById = new Map((source.blocks ?? []).map((b) => [b.id, b]));
  const figureNode = (fig) => {
    const src = `/api/papers/${encodeURIComponent(paperId)}/figures/${encodeURIComponent(fig.image)}`;
    let cap = sentences[fig.captionSentenceId]?.text ?? fig.label ?? '';
    if (cap.length > 160) cap = `${cap.slice(0, 160)}…`;
    const img = el('img', { loading: 'lazy', decoding: 'async', alt: cap, src });
    const link = el('a', { href: src, target: '_blank', rel: 'noopener noreferrer', title: '새 탭에서 원본 크기로 열기' }, img);
    const fail = el('p', { class: 'fig-fail muted', hidden: true }, '그림을 불러오지 못했습니다 — ', pageLink(fig.page, links));
    img.addEventListener('error', () => { link.hidden = true; fail.hidden = false; });
    return el('figure', { class: 'src-figure', id: domIds.get(fig) }, link, fail);
  };
  const foldedText = (fig) => {
    // document order, whichever side of the caption the blocks sit on
    const order = (source.blocks ?? []).filter((x) => (fig.blockIds ?? []).includes(x.id)
      && layout.get(x.id)?.figure === fig && layout.get(x.id).role === 'folded');
    if (!order.length) return null;
    const d = el('details', { class: 'fig-text' }, el('summary', { text: '그림 속 글자 보기' }));
    for (const x of order) d.append(blockEl(x));
    return d;
  };

  for (const b of source.blocks ?? []) {
    const ids = b.sentenceIds ?? [];
    const lay = layout.get(b.id);
    if (lay?.role === 'folded') continue;
    if (b.type === 'references') {
      if (!refs) {
        refs = el('details', { class: 'refs' });
        refs.append(el('summary', {}));
        body.append(refs);
      }
      refsCount += 1;
      refs.append(el('p', { class: 'ref' }, sentenceSpans(ids)));
      continue;
    }
    if (b.page !== lastPage) {
      body.append(el('div', { class: 'page-mark', 'aria-hidden': 'true', text: `p.${b.page}` }));
      lastPage = b.page;
    }
    if (lay?.role === 'image-before') {
      body.append(figureNode(lay.figure));
      const d = foldedText(lay.figure);
      if (d) body.append(d);
    }
    body.append(blockEl(b));
  }
  if (refs) refs.querySelector('summary').textContent = `참고문헌 (${refsCount})`;

  const tab = (name, label) => el('button', {
    type: 'button', role: 'tab', class: 'src-tab', id: `src-tab-${name}`, 'aria-controls': `src-pane-${name}`,
    'aria-selected': 'false', tabindex: -1, dataset: { tab: name }, text: label,
  });
  const pdfTab = tab('pdf', 'PDF');
  const textTab = tab('text', '글로 읽기');
  const pdfPane = el('div', { class: 'src-pane src-pane-pdf', id: 'src-pane-pdf', role: 'tabpanel', 'aria-labelledby': 'src-tab-pdf', hidden: true });
  const textPane = el('div', { class: 'src-pane src-pane-text', id: 'src-pane-text', role: 'tabpanel', 'aria-labelledby': 'src-tab-text', hidden: true });
  textPane.append(el('header', { class: 'source-head' },
      el('h2', { class: 'source-title', text: meta.title || source.id }),
      el('p', { class: 'muted', text: [
        authors.length > 3 ? `${authors.slice(0, 3).join(', ')} 외` : authors.join(', '),
        meta.journal, meta.date,
      ].filter(Boolean).join(' · ') }),
      el('p', { class: 'source-links' },
        meta.doi ? el('a', { href: `https://doi.org/${meta.doi}`, target: '_blank', rel: 'noopener noreferrer', text: `DOI ${meta.doi}` }) : null,
        links.zoteroItem ? el('a', { href: links.zoteroItem, text: 'Zotero에서 보기' }) : null,
      ),
    ), body);

  const toolHost = el('div', { class: 'src-tools', hidden: true });
  const panel = el('aside', { class: 'source', id: 'source-panel', 'aria-label': '원문' },
    el('div', { class: 'src-top' },
      el('span', { class: 'sheet-title', text: '원문' }),
      el('div', { class: 'src-tabs', role: 'tablist', 'aria-label': '원문 보기 방식' }, pdfTab, textTab),
      el('button', { type: 'button', class: 'btn btn-quiet sheet-close', text: '닫기', onclick: onClose }),
      toolHost,
    ),
    pdfPane,
    textPane,
  );
  return { panel, pdfTab, textTab, pdfPane, textPane, toolHost };
}

function readStoredTab() {
  try { return localStorage.getItem(TAB_KEY); } catch { return null; }
}
function storeTab(tab) {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode / blocked storage: keep the default */ }
}

// Make / remake the digest from the paper view. Returns { button, box, dispose }.
// The current digest stays on screen while a job runs; on success the user reloads by choice.
function digestControl({ id, hasDigest, example, actions }) {
  const box = el('div', { class: 'digest-job', hidden: true });
  if (!actions.startDigest || example) return { button: null, box, dispose() {} };
  const button = hasDigest
    ? el('button', {
      type: 'button', class: 'btn btn-quiet btn-small remake-btn', text: '요약 다시 만들기',
      title: '새 요약이 검증을 통과할 때까지 지금 요약은 그대로 둡니다.',
    })
    : el('button', { type: 'button', class: 'btn digest-btn', text: '요약 만들기' });
  const status = el('span', { class: 'job-status', role: 'status' });
  const cancel = el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: '취소' });
  const logList = el('ol', {});
  const logBox = el('details', { class: 'job-log', hidden: true }, el('summary', { text: '로그 보기' }), logList);
  let watcher = null;
  let sawBusy = false;
  let disposed = false;

  const show = (job) => {
    const v = jobView(job);
    if (!v) { box.hidden = true; return; }
    box.hidden = false;
    box.dataset.tone = v.tone;
    button.disabled = v.busy;
    const log = job.log ?? [];
    logList.replaceChildren(...log.slice(-20).map((l) => el('li', { text: l })));
    logBox.hidden = !log.length;
    if (v.busy) {
      status.textContent = v.text;
      box.replaceChildren(status, cancel, logBox);
      cancel.disabled = false;
      return;
    }
    if (job.state === 'done') {
      const reload = el('button', { type: 'button', class: 'btn btn-small', text: '새로고침', onclick: () => actions.refreshList() });
      status.textContent = '새 요약이 준비되었습니다';
      box.replaceChildren(status, reload, logBox);
      return;
    }
    status.textContent = v.text;
    box.replaceChildren(status, logBox);
  };
  const watch = () => {
    watcher?.stop();
    const w = watchJob({
      id,
      actions,
      onUpdate(job) {
        if (disposed || watcher !== w) return;
        if (jobView(job)?.busy) { sawBusy = true; show(job); return; }
        // Old results from before this page opened are not shown.
        if (sawBusy && job) {
          show(job);
          // Failures stay tracked so the list row keeps the message until dismissed.
          if (job.state !== 'failed') actions.digestTracker?.untrack(id);
        } else box.hidden = true;
      },
    });
    watcher = w;
    w.start();
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const job = await actions.startDigest(id);
      actions.digestTracker?.track(id);
      sawBusy = true;
      show(job);
      watch();
    } catch (err) {
      actions.toast(err.message);
      button.disabled = false;
    }
  });
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    try { await actions.cancelDigest(id); } catch (err) { actions.toast(err.message); cancel.disabled = false; }
  });
  watch(); // a job may already be running (started from the list)
  return { button, box, dispose() { disposed = true; watcher?.stop(); } };
}

// data: { id, source, digest, problems, progress, links }
// actions: { saveProgress(id, progress): Promise, toast(msg) }
// Returns a dispose() function.
export function render(container, data, actions) {
  clear(container);
  const { source = {}, digest, problems = [], links = {} } = data;
  const cards = digest?.cards ?? [];
  const glossary = digest?.glossary ?? [];
  const state = {
    read: new Set(data.progress?.read ?? []),
    mode: data.progress?.mode === '3min' ? '3min' : '10min',
    focus: data.progress?.focus === true,
    current: null,
    highlighted: [],
    tab: null,
  };
  const mobile = window.matchMedia(MOBILE_QUERY);
  document.body.classList.add('paper-mode');

  const root = el('div', { class: 'paper' });
  const flow = el('section', { class: 'flow', 'aria-label': '요약 흐름' });
  const src = sourcePanel(source, links, () => setSheet(false), data.id);
  const source_ = src.panel;
  const progressSlot = el('div', { class: 'top-progress' });
  const dj = digestControl({ id: data.id, hasDigest: !!digest, example: data.example === true, actions });

  const save = () => {
    actions.saveProgress(data.id, { read: [...state.read], mode: state.mode, focus: state.focus });
  };

  function setSheet(open) {
    source_.classList.toggle('open', open);
  }

  function sentenceEl(sid) {
    return document.getElementById(sentenceHtmlId(sid));
  }

  function markCurrentEvidence() {
    for (const n of source_.querySelectorAll('.sent.ev-on')) n.classList.remove('ev-on');
    const card = cards.find((c) => c.id === state.current);
    const ids = card ? cardEvidence(card, state.mode) : [];
    for (const sid of ids) sentenceEl(sid)?.classList.add('ev-on');
    pdf.view?.setEvidence(ids);
  }

  // ----- source tabs: [PDF] [글로 읽기] -----
  const hasPdf = links.pdf === true && data.example !== true;
  const pdf = { view: null, failed: false };
  const textScroll = { top: 0 };
  const pdfActive = () => state.tab === 'pdf' && pdf.view && !pdf.failed;

  function pdfMessage(text, withButton) {
    src.pdfPane.replaceChildren(el('div', { class: 'pdf-msg' },
      el('p', { text }),
      // Not stored: a paper without a PDF (or a failed open) must not make every later PDF open as text.
      withButton ? el('button', { type: 'button', class: 'btn btn-quiet', text: '글로 읽기로 보기', onclick: () => setTab('text', { focus: true }) }) : null,
    ));
  }

  function openPdf() {
    if (pdf.view || pdf.failed) return;
    if (!hasPdf) { pdfMessage('이 논문은 PDF가 없어 글로만 볼 수 있습니다.', true); return; }
    const box = el('div', { class: 'pdf-view' });
    src.pdfPane.replaceChildren(box);
    pdf.view = createPdfView({
      paperId: data.id, source, container: box, toolbarHost: src.toolHost,
      onError: (err) => {
        pdf.failed = true;
        pdf.view?.dispose();
        pdf.view = null;
        src.toolHost.hidden = true;
        pdfMessage(`PDF를 열 수 없습니다: ${err.message}`, true);
        if (state.tab === 'pdf') setTab('text');
      },
    });
    src.toolHost.hidden = state.tab !== 'pdf';
    markCurrentEvidence();
    notesCtl?.pdfChanged();
  }

  function setTab(tab, { user = false, focus = false } = {}) {
    if (state.tab === 'text' && tab !== 'text') textScroll.top = source_.scrollTop;
    const prev = state.tab;
    state.tab = tab;
    for (const [name, t, pane] of [['pdf', src.pdfTab, src.pdfPane], ['text', src.textTab, src.textPane]]) {
      const on = name === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      pane.hidden = !on;
    }
    source_.classList.toggle('tab-pdf', tab === 'pdf');
    src.toolHost.hidden = !(tab === 'pdf' && pdf.view);
    if (tab === 'pdf') openPdf();
    else if (prev !== 'text') source_.scrollTop = textScroll.top;
    if (user) storeTab(tab);
    if (focus) (tab === 'pdf' ? src.pdfTab : src.textTab).focus();
  }

  src.pdfTab.addEventListener('click', () => setTab('pdf', { user: true }));
  src.textTab.addEventListener('click', () => setTab('text', { user: true }));
  src.pdfTab.parentElement.addEventListener('keydown', (e) => {
    const order = ['pdf', 'text'];
    const at = order.indexOf(state.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = order[(at + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(at + order.length - 1) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next, { user: true, focus: true });
  });

  function setCurrent(cardId) {
    if (cardId === state.current) return;
    state.current = cardId;
    for (const n of flow.querySelectorAll('.card')) {
      const on = n.dataset.cardId === cardId;
      n.classList.toggle('current', on);
      if (on) n.setAttribute('aria-current', 'true');
      else n.removeAttribute('aria-current');
    }
    markCurrentEvidence();
  }

  // On the PDF tab with no PDF to show (none, or failed): use the text view for evidence/figures.
  const leaveEmptyPdfTab = () => { if (state.tab === 'pdf' && !pdfActive()) setTab('text'); };

  function showEvidence(ids, cardId) {
    if (cardId) setCurrent(cardId);
    leaveEmptyPdfTab();
    for (const n of state.highlighted) n.classList.remove('hl');
    state.highlighted = ids.map(sentenceEl).filter(Boolean);
    if (pdfActive()) {
      for (const n of state.highlighted) n.classList.add('hl');
      if (mobile.matches) setSheet(true);
      if (!pdf.view.scrollToSentences(ids)) actions.toast('PDF에서 근거 문장을 찾지 못했습니다.');
      return;
    }
    if (!state.highlighted.length) {
      actions.toast('원문에서 근거 문장을 찾지 못했습니다.');
      return;
    }
    for (const n of state.highlighted) {
      n.classList.add('hl');
      const det = n.closest('details');
      if (det) det.open = true;
    }
    const first = state.highlighted[0];
    const go = () => first.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    if (mobile.matches) {
      setSheet(true);
      requestAnimationFrame(go);
    } else {
      go();
    }
  }

  const figLayout = figureLayout(source);
  const hasImage = (f) => Boolean(findFigure(source.figures, f)?.image) && figLayout.size > 0;
  function showFigure(f) {
    const fig = findFigure(source.figures, f);
    leaveEmptyPdfTab();
    if (pdfActive()) {
      if (mobile.matches) setSheet(true);
      const cap = fig?.captionSentenceId;
      if (!(cap && pdf.view.scrollToSentences([cap]))) pdf.view.scrollToPage(fig?.page ?? f.page);
      return;
    }
    const idx = fig ? (source.figures ?? []).indexOf(fig) : -1;
    const node = idx >= 0 ? document.getElementById(figureDomIds(source.figures)[idx]) : null;
    if (!node) { actions.toast('원문에서 그림을 찾지 못했습니다.'); return; }
    const go = () => {
      node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 1200);
    };
    if (mobile.matches) { setSheet(true); requestAnimationFrame(go); } else go();
  }

  function renderProgress() {
    const ids = new Set(cards.map((c) => c.id));
    const done = [...state.read].filter((r) => ids.has(r)).length;
    progressSlot.replaceChildren(
      progressBar(done, cards.length, '읽은 카드 비율'),
      el('span', { class: 'progress-text', text: `${done}/${cards.length} 읽음` }),
    );
  }

  function cardNode(card, idx, seen) {
    const items = visibleItems(card, state.mode);
    const full = state.mode === '10min';
    const check = el('input', { type: 'checkbox' });
    check.checked = state.read.has(card.id);
    check.addEventListener('change', () => {
      if (check.checked) state.read.add(card.id);
      else state.read.delete(card.id);
      node.classList.toggle('is-read', check.checked);
      renderProgress();
      save();
    });
    const node = el('article', {
      class: `card${state.read.has(card.id) ? ' is-read' : ''}${state.current === card.id ? ' current' : ''}`,
      dataset: { cardId: card.id },
      'aria-labelledby': `q-${card.id}`,
      onclick: () => setCurrent(card.id),
    },
    el('div', { class: 'card-head' },
      el('span', { class: 'card-num', text: String(idx + 1) }),
      SECTION_LABELS[card.section] ? el('span', { class: 'section-tag', text: SECTION_LABELS[card.section] }) : null,
    ),
    el('h2', { class: 'question', id: `q-${card.id}` }, richText(card.question, glossary, seen)),
    el('p', { class: 'answer' }, richText(card.answer, glossary, seen)),
    full && card.explain ? el('p', { class: 'explain' }, richText(card.explain, glossary, seen)) : null,
    items.length ? el('ul', { class: 'items' }, items.map((it) => el('li', { class: `item item-${it.kind}` },
      it.label ? el('strong', { class: 'item-label', text: it.label }) : null,
      el('span', { class: 'item-text' }, richText(it.text, glossary, seen)),
      evidenceButton(it.evidence, showEvidence, card.id),
    ))) : null,
    full && card.bigNumbers?.length ? el('div', { class: 'bignums' }, card.bigNumbers.map((b) => el('div', { class: 'bignum' },
      el('span', { class: 'bignum-value', text: b.value }),
      el('span', { class: 'bignum-label' }, richText(b.label, glossary, seen)),
      evidenceButton(b.evidence, showEvidence, card.id),
    ))) : null,
    full && card.tables?.length ? card.tables.map((t) => tableNode(t, showEvidence, card.id)) : null,
    full && card.figures?.length ? el('ul', { class: 'figures', 'aria-label': '그림' }, card.figures.map((f) => figureLine(f, links, hasImage(f) ? showFigure : null))) : null,
    memos?.memoNode(card.id),
    el('label', { class: 'read-check' }, check, ' 읽음'),
    );
    if (state.current === card.id) node.setAttribute('aria-current', 'true');
    return node;
  }

  let observer = null;
  function renderFlow() {
    observer?.disconnect();
    clear(flow);
    if (!digest) {
      flow.append(el('div', { class: 'card empty-card' },
        el('h2', { text: '아직 요약이 없습니다' }),
        dj.button
          ? el('p', { text: '요약 만들기를 누르면 선택한 AI 도구가 요약을 쓰고, 서버가 검증한 뒤 저장합니다. 오른쪽에서 원문은 바로 읽을 수 있습니다.' })
          : el('p', { text: 'AI로 digest.json을 작성한 뒤 npm run check로 확인하세요. 오른쪽에서 원문은 바로 읽을 수 있습니다.' }),
        dj.button ? el('div', { class: 'empty-actions' }, dj.button) : null,
        dj.box));
      return;
    }
    if (!cards.length) {
      flow.append(el('p', { class: 'empty', text: '표시할 카드가 없습니다.' }));
      return;
    }
    memos?.reset();
    if (memos) flow.append(memos.bannerNode);
    const seen = new Set();
    cards.forEach((card, idx) => {
      flow.append(cardNode(card, idx, seen));
      if (card.bridge && idx < cards.length - 1) {
        flow.append(el('p', { class: 'bridge' }, richText(card.bridge, glossary, seen)));
      }
    });
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) setCurrent(hit.target.dataset.cardId);
      }, { rootMargin: '-30% 0px -65% 0px' });
      for (const n of flow.querySelectorAll('.card')) observer.observe(n);
    }
    markCurrentEvidence();
  }

  function toggleButton(label, pressed, onclick) {
    return el('button', { type: 'button', class: 'toggle', 'aria-pressed': String(pressed), text: label, onclick });
  }

  const modeGroup = el('div', { class: 'seg', role: 'group', 'aria-label': '읽기 분량' });
  const focusBtn = toggleButton('집중 모드', state.focus, () => {
    state.focus = !state.focus;
    focusBtn.setAttribute('aria-pressed', String(state.focus));
    root.classList.toggle('focus', state.focus);
    save();
  });
  function renderModeGroup() {
    modeGroup.replaceChildren(...[['3min', '3분'], ['10min', '10분']].map(([m, label]) => toggleButton(label, state.mode === m, () => {
      if (state.mode === m) return;
      state.mode = m;
      renderModeGroup();
      renderFlow();
      save();
    })));
  }
  renderModeGroup();

  let notesCtl = null;
  const memos = actions.notes && actions.saveCardMemo
    ? setupCardMemos({
      id: data.id, actions, example: data.example === true, getMode: () => state.mode, refresh: () => notesCtl?.refresh(),
    })
    : null;
  notesCtl = actions.notes
    ? setupNotes({
      id: data.id, source, panel: source_, actions, example: data.example === true, onNotes: (n) => memos?.update(n),
      pdf: { view: () => pdf.view, pane: src.pdfPane },
    })
    : null;
  const notesStatus = notesCtl?.statusNode ?? null;

  const tk = digest?.takeaway;
  const topbar = el('header', { class: 'topbar' },
    el('div', { class: 'topbar-row' },
      el('a', { class: 'back', href: '#/', text: '← 목록' }),
      el('h1', { class: 'paper-title', tabindex: -1, text: source.meta?.title || data.id }),
      cards.length ? el('div', { class: 'controls' }, modeGroup, focusBtn) : null,
      digest ? dj.button : null,
      el('button', { type: 'button', class: 'btn btn-quiet sheet-open', 'aria-controls': 'source-panel', text: '원문 보기', onclick: () => setSheet(true) }),
    ),
    digest ? dj.box : null,
    tk?.text ? el('div', { class: 'takeaway' },
      el('span', { class: 'takeaway-label', text: '핵심' }),
      el('p', { class: 'takeaway-text' }, tk.text, evidenceButton(tk.evidence, showEvidence, null)),
      tk.why ? el('p', { class: 'takeaway-why', text: tk.why }) : null,
    ) : null,
    cards.length ? progressSlot : null,
    notesStatus,
  );

  const banner = problems.length ? el('details', { class: 'banner', role: 'status' },
    el('summary', { text: `요약 일부를 확인하지 못했습니다(${problems.length}건)` }),
    el('ul', {}, problems.map((p) => el('li', { text: p }))),
  ) : null;

  setTab(initialSourceTab({ hasPdf, stored: readStoredTab() }));

  root.classList.toggle('focus', state.focus);
  root.append(...[topbar, banner, el('div', { class: 'columns' }, flow, source_)].filter(Boolean));
  container.append(root);
  renderProgress();
  renderFlow();

  const onKey = (e) => { if (e.key === 'Escape') setSheet(false); };
  document.addEventListener('keydown', onKey);
  return () => {
    observer?.disconnect();
    dj.dispose();
    pdf.view?.dispose();
    memos?.dispose();
    notesCtl?.dispose();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('paper-mode');
  };
}
