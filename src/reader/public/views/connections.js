// "연구 연결 메모" — AI-written links between this paper and the user's research note.
// Kept apart from the summary cards (not paper content, not part of reading progress or card focus).
// Pure helpers are tested in Node; DOM pieces only touch `document` when called.
import { el, setChildren } from './dom.js';
import { jobView, watchJob, logDetails } from './digest.js';
import { obsidianReady } from './obsidian.js';

export const CONN_EMPTY_TEXT = '연구 주제 노트와 이어지는 내용을 찾지 못했습니다.';
export const CONN_MAX = 300;
const INTRO = '연구 주제 노트를 읽고 이 논문과 이어지는 곳을 AI가 짧게 적습니다. 목록 화면에서 고른 AI 도구를 씁니다.';

const noteNameOf = (p) => (typeof p === 'string' && p ? p.split('/').pop().replace(/\.md$/i, '') : null);

// Pure: what the section shows.
// state: { settings (GET /api/obsidian/settings | null), connections (file | null), job (shown job | null), example, hasDigest }
export function connectionsView({ settings, connections, job, example = false, hasDigest = false } = {}) {
  if (example || !hasDigest) return { show: false };
  const ready = obsidianReady(settings);
  const status = jobView(job);
  const busy = status?.busy === true;
  const items = (Array.isArray(connections?.items) ? connections.items : [])
    .filter((it) => it && typeof it === 'object' && typeof it.id === 'string')
    .map((it) => ({
      id: it.id,
      target: typeof it.target === 'string' ? it.target : '',
      text: typeof it.text === 'string' ? it.text : '',
      evidence: Array.isArray(it.evidence) ? it.evidence.filter((s) => typeof s === 'string') : [],
      edited: it.edited === true,
    }));
  const has = Boolean(connections);
  return {
    show: true,
    configured: ready.connections,
    hint: ready.connectionsHint,
    intro: has ? null : INTRO,
    button: { text: has ? '다시 만들기' : '연결 메모 만들기', disabled: !ready.connections || busy },
    busy,
    status,
    items,
    emptyText: has && items.length === 0 ? CONN_EMPTY_TEXT : null,
    editable: !busy,
    open: items.length > 0 || busy,
    noteName: noteNameOf(connections?.researchNote),
    otherNote: Boolean(connections?.researchNote && settings?.researchNote && connections.researchNote !== settings.researchNote),
  };
}

// actions: connections(id), connectionsJob(id) → job|null, startConnections(id), cancelConnections(id),
//   editConnection(id, itemId, text), deleteConnection(id, itemId), toast(msg).
// onEvidence(ids) highlights evidence in the source panel. Returns { node, setSettings(s), dispose() }.
export function setupConnections({ id, actions, example = false, hasDigest = false, onEvidence }) {
  const st = {
    settings: null, connections: null, job: null, sawBusy: false,
    editing: null, draft: '', confirming: null, pending: false, loaded: false, everOpened: false,
  };
  let disposed = false;
  let watcher = null;
  const summaryCount = el('span', { class: 'conn-count' });
  const details = el('details', { class: 'conn' },
    el('summary', { class: 'conn-summary' },
      el('h2', { class: 'conn-title', id: 'conn-title', text: '연구 연결 메모' }),
      el('span', { class: 'conn-badge', text: 'AI가 쓴 연결점 · 논문 내용 아님' }),
      summaryCount,
    ));
  const body = el('div', { class: 'conn-body' });
  details.append(body);
  const node = el('section', { class: 'conn-section', 'aria-labelledby': 'conn-title', hidden: true }, details);
  details.addEventListener('toggle', () => { if (details.open) st.everOpened = true; });

  const view = () => connectionsView({ settings: st.settings, connections: st.connections, job: st.job, example, hasDigest });

  function itemNode(it, v) {
    const editing = st.editing === it.id;
    const confirming = st.confirming === it.id;
    const lock = !v.editable || st.pending;
    const lockTitle = !v.editable ? '연결 메모를 만드는 중에는 고칠 수 없습니다.' : null;
    const parts = [
      el('p', { class: 'conn-target' }, el('span', { class: 'conn-target-label', text: '연결 대상' }), ' ', el('span', { text: it.target || '(제목 없음)' })),
    ];
    if (editing) {
      const ta = el('textarea', {
        id: `conn-edit-${it.id}`, class: 'conn-textarea', rows: 4, maxlength: CONN_MAX, 'aria-describedby': `conn-count-${it.id}`,
      });
      ta.value = st.draft;
      const count = el('span', { class: 'conn-charcount', id: `conn-count-${it.id}`, 'aria-live': 'polite' });
      const save = el('button', { type: 'button', class: 'btn btn-small', text: '저장' });
      const cancel = el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: '취소' });
      const sync = () => {
        st.draft = ta.value;
        count.textContent = `${ta.value.length}/${CONN_MAX}`;
        save.disabled = st.pending || !v.editable || !ta.value.trim() || ta.value.length > CONN_MAX;
      };
      ta.addEventListener('input', sync);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.click(); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!save.disabled) save.click(); }
      });
      save.addEventListener('click', () => mutate(it.id, () => actions.editConnection(id, it.id, ta.value)));
      cancel.addEventListener('click', () => { st.editing = null; render({ focus: `[data-conn-edit="${it.id}"]` }); });
      sync();
      parts.push(
        el('label', { class: 'sr-only', for: `conn-edit-${it.id}`, text: '연결 설명 고치기' }),
        ta,
        el('div', { class: 'conn-item-actions' }, count, save, cancel),
      );
    } else {
      parts.push(el('p', { class: 'conn-text' },
        it.text,
        it.edited ? el('span', { class: 'conn-edited', text: '직접 고침' }) : null));
      const ev = it.evidence.length ? el('button', {
        type: 'button', class: 'ev-btn', title: `원문 근거 보기 (${it.evidence.join(', ')})`,
        'aria-label': `원문 근거 문장 ${it.evidence.length}개 보기`, onclick: () => onEvidence?.(it.evidence),
      }, '🔗') : null;
      if (confirming) {
        const yes = el('button', { type: 'button', class: 'btn btn-small conn-delete-yes', text: '삭제', disabled: lock });
        const no = el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: '취소' });
        yes.addEventListener('click', () => mutate(it.id, () => actions.deleteConnection(id, it.id), { deleted: true }));
        no.addEventListener('click', () => { st.confirming = null; render({ focus: `[data-conn-del="${it.id}"]` }); });
        parts.push(el('div', { class: 'conn-item-actions conn-confirm', role: 'group', 'aria-label': '삭제 확인' },
          ev, el('span', { class: 'conn-confirm-text', text: '이 연결 메모를 지울까요?' }), yes, no));
      } else {
        const edit = el('button', {
          type: 'button', class: 'btn btn-quiet btn-small', text: '고치기', disabled: lock, title: lockTitle, dataset: { connEdit: it.id },
        });
        const del = el('button', {
          type: 'button', class: 'btn btn-quiet btn-small', text: '삭제', disabled: lock, title: lockTitle, dataset: { connDel: it.id },
        });
        edit.addEventListener('click', () => {
          st.editing = it.id; st.confirming = null; st.draft = it.text;
          render({ focus: `#conn-edit-${it.id}` });
        });
        del.addEventListener('click', () => { st.confirming = it.id; st.editing = null; render({ focus: '.conn-delete-yes' }); });
        parts.push(el('div', { class: 'conn-item-actions' }, ev, edit, del));
      }
    }
    return el('li', { class: 'conn-item', dataset: { itemId: it.id } }, parts);
  }

  function render({ focus } = {}) {
    if (disposed) return;
    const v = view();
    node.hidden = !v.show;
    if (!v.show) return;
    if (v.open && !st.everOpened) details.open = true;
    summaryCount.textContent = v.items.length ? `${v.items.length}개` : '';

    const actionsRow = el('div', { class: 'conn-actions' });
    const make = el('button', {
      type: 'button', class: v.items.length || st.connections ? 'btn btn-quiet btn-small' : 'btn btn-small',
      text: v.button.text, disabled: v.button.disabled || !st.loaded,
      title: v.hint ?? (st.connections ? '새 연결 메모가 검증을 통과하면 지금 메모(고친 내용 포함)를 바꿉니다.' : null),
    });
    make.addEventListener('click', start);
    actionsRow.append(make);
    if (v.status) {
      actionsRow.append(el('span', { class: 'job-status conn-status', role: 'status', dataset: { tone: v.status.tone }, text: v.status.text }));
      if (v.busy) {
        const cancel = el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: '취소' });
        cancel.addEventListener('click', async () => {
          cancel.disabled = true;
          try { await actions.cancelConnections(id); } catch (err) { actions.toast(err.message); cancel.disabled = false; }
        });
        actionsRow.append(cancel);
      }
      const log = logDetails(st.job);
      if (log) actionsRow.append(log);
    }

    setChildren(body,
      v.hint ? el('p', { class: 'conn-hint', text: v.hint }) : null,
      v.intro ? el('p', { class: 'conn-intro', text: v.intro }) : null,
      v.noteName ? el('p', { class: 'conn-note' },
        `연구 주제 노트: ${v.noteName}`,
        v.otherNote ? el('span', { class: 'conn-other', text: ' — 지금 고른 노트와 다른 노트로 만든 메모입니다' }) : null) : null,
      actionsRow,
      v.items.length ? el('ul', { class: 'conn-items' }, v.items.map((it) => itemNode(it, v))) : null,
      v.emptyText ? el('p', { class: 'conn-empty', text: v.emptyText }) : null,
    );
    if (focus) body.querySelector(focus)?.focus();
  }

  async function reload() {
    try {
      const r = await actions.connections(id);
      if (disposed) return;
      st.connections = r?.connections ?? null;
    } catch (err) {
      if (!disposed) actions.toast(err.message);
    }
  }

  function watch() {
    watcher?.stop();
    const w = watchJob({
      id,
      actions,
      get: (x) => actions.connectionsJob(x),
      async onUpdate(job) {
        if (disposed || watcher !== w) return;
        if (jobView(job)?.busy) { st.sawBusy = true; st.job = job; render(); return; }
        // Results from before this page opened are not shown.
        if (st.sawBusy && job) {
          st.job = job;
          if (job.state === 'done') await reload();
          if (disposed) return;
          if (job.state === 'done' && st.connections?.items?.length) details.open = true;
        }
        render();
      },
    });
    watcher = w;
    w.start();
  }

  async function start() {
    st.pending = true;
    render();
    try {
      const job = await actions.startConnections(id);
      if (disposed) return;
      st.job = job;
      st.sawBusy = true;
      st.editing = null;
      st.confirming = null;
      details.open = true;
      watch();
    } catch (err) {
      actions.toast(err.message);
    } finally {
      st.pending = false;
      render();
    }
  }

  // Edit / delete one item. 409 = a connections job is running (maybe from another tab): pick up its progress.
  async function mutate(itemId, call, { deleted = false } = {}) {
    st.pending = true;
    render();
    try {
      const r = await call();
      if (disposed) return;
      st.connections = r?.connections ?? st.connections;
      st.editing = null;
      st.confirming = null;
      st.pending = false;
      render({ focus: deleted ? '.conn-actions button' : `[data-conn-edit="${itemId}"]` });
      actions.toast(deleted ? '연결 메모를 지웠습니다.' : '연결 메모를 고쳤습니다.');
    } catch (err) {
      st.pending = false;
      actions.toast(err.message);
      if (err.status === 409) { st.sawBusy = true; watch(); }
      render();
    }
  }

  if (!example && hasDigest && actions.connections) {
    Promise.all([
      reload(),
      actions.connectionsJob(id).then((job) => {
        if (!disposed && jobView(job)?.busy) { st.job = job; st.sawBusy = true; watch(); }
      }, () => {}),
    ]).then(() => { st.loaded = true; render(); });
  }

  return {
    node,
    setSettings(s) { st.settings = s; render(); },
    dispose() { disposed = true; watcher?.stop(); },
  };
}
