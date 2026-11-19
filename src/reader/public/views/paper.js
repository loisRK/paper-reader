import { el, clear, progressBar } from './dom.js';
import { setupNotes } from './notes.js';
import { setupCardMemos } from './card-memos.js';

const SECTION_LABELS = {
  motivation: '동기', gap: '빈틈(Gap)', idea: '아이디어', method: '방법', setup: '실험 설정',
  results: '결과', analysis: '분석', limits: '한계', implications: '시사점',
};
const MOBILE_QUERY = '(max-width: 959.98px)';

// ---------- pure helpers (tested in Node) ----------

export function visibleItems(card, mode) {
  if (mode === '3min') return [];
  return Array.isArray(card?.items) ? card.items : [];
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

function figureLine(f, links) {
  const pageText = `p.${f.page}`;
  return el('li', { class: 'figure' },
    el('span', { class: 'figure-label', text: f.label || '그림' }),
    ' ',
    links.zoteroPdf
      ? el('a', { href: `${links.zoteroPdf}?page=${f.page}`, text: `Zotero에서 ${pageText} 열기` })
      : el('span', { class: 'muted', text: pageText }),
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

function sourcePanel(source, links, onClose) {
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

  for (const b of source.blocks ?? []) {
    const ids = b.sentenceIds ?? [];
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
    if (b.type === 'heading') body.append(el('h3', { class: 'src-heading' }, sentenceSpans(ids)));
    else if (b.type === 'caption') body.append(el('p', { class: 'caption' }, sentenceSpans(ids)));
    else body.append(el('p', { class: 'para' }, sentenceSpans(ids)));
  }
  if (refs) refs.querySelector('summary').textContent = `참고문헌 (${refsCount})`;

  return el('aside', { class: 'source', id: 'source-panel', 'aria-label': '원문' },
    el('div', { class: 'sheet-bar' },
      el('span', { class: 'sheet-title', text: '원문' }),
      el('button', { type: 'button', class: 'btn btn-quiet', text: '닫기', onclick: onClose }),
    ),
    el('header', { class: 'source-head' },
      el('h2', { class: 'source-title', text: meta.title || source.id }),
      el('p', { class: 'muted', text: [
        authors.length > 3 ? `${authors.slice(0, 3).join(', ')} 외` : authors.join(', '),
        meta.journal, meta.date,
      ].filter(Boolean).join(' · ') }),
      el('p', { class: 'source-links' },
        meta.doi ? el('a', { href: `https://doi.org/${meta.doi}`, target: '_blank', rel: 'noopener noreferrer', text: `DOI ${meta.doi}` }) : null,
        links.zoteroItem ? el('a', { href: links.zoteroItem, text: 'Zotero에서 보기' }) : null,
      ),
    ),
    body,
  );
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
  };
  const mobile = window.matchMedia(MOBILE_QUERY);
  document.body.classList.add('paper-mode');

  const root = el('div', { class: 'paper' });
  const flow = el('section', { class: 'flow', 'aria-label': '요약 흐름' });
  const source_ = sourcePanel(source, links, () => setSheet(false));
  const progressSlot = el('div', { class: 'top-progress' });

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
    if (!card) return;
    for (const sid of cardEvidence(card, state.mode)) sentenceEl(sid)?.classList.add('ev-on');
  }

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

  function showEvidence(ids, cardId) {
    if (cardId) setCurrent(cardId);
    for (const n of state.highlighted) n.classList.remove('hl');
    state.highlighted = ids.map(sentenceEl).filter(Boolean);
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
      it.kind === 'opinion' ? el('span', { class: 'opinion-badge', text: '💬 해석' }) : null,
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
    full && card.figures?.length ? el('ul', { class: 'figures', 'aria-label': '그림' }, card.figures.map((f) => figureLine(f, links))) : null,
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
        el('p', { text: 'AI로 digest.json을 작성한 뒤 npm run check로 확인하세요. 오른쪽에서 원문은 바로 읽을 수 있습니다.' })));
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
    ? setupNotes({ id: data.id, source, panel: source_, actions, example: data.example === true, onNotes: (n) => memos?.update(n) })
    : null;
  const notesStatus = notesCtl?.statusNode ?? null;

  const tk = digest?.takeaway;
  const topbar = el('header', { class: 'topbar' },
    el('div', { class: 'topbar-row' },
      el('a', { class: 'back', href: '#/', text: '← 목록' }),
      el('h1', { class: 'paper-title', tabindex: -1, text: source.meta?.title || data.id }),
      cards.length ? el('div', { class: 'controls' }, modeGroup, focusBtn) : null,
      el('button', { type: 'button', class: 'btn btn-quiet sheet-open', 'aria-controls': 'source-panel', text: '원문 보기', onclick: () => setSheet(true) }),
    ),
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

  root.classList.toggle('focus', state.focus);
  root.append(...[topbar, banner, el('div', { class: 'columns' }, flow, source_)].filter(Boolean));
  container.append(root);
  renderProgress();
  renderFlow();

  const onKey = (e) => { if (e.key === 'Escape') setSheet(false); };
  document.addEventListener('keydown', onKey);
  return () => {
    observer?.disconnect();
    memos?.dispose();
    notesCtl?.dispose();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('paper-mode');
  };
}
