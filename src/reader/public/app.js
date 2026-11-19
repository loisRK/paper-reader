// Hash router: #/  ·  #/search/<name>  ·  #/paper/<id>
import * as listView from './views/list.js';
import * as searchView from './views/search.js';
import * as paperView from './views/paper.js';

const app = document.getElementById('app');
const toastBox = document.getElementById('toast');
let dispose = null;
let toastTimer = null;

function toast(message) {
  toastBox.textContent = message;
  toastBox.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.remove('show'), 4000);
}

async function api(url, init) {
  const res = await fetch(url, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

const sendJson = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const actions = {
  toast,
  async saveProgress(id, progress) {
    try {
      await api(`/api/papers/${encodeURIComponent(id)}/progress`, sendJson('PUT', progress));
    } catch (err) {
      toast(`진행 상황을 저장하지 못했습니다: ${err.message}`);
    }
  },
  notes: (id) => api(`/api/papers/${encodeURIComponent(id)}/notes`),
  addHighlight: (id, body) => api(`/api/papers/${encodeURIComponent(id)}/highlights`, sendJson('POST', body)),
  updateHighlight: (id, hid, body) => api(`/api/papers/${encodeURIComponent(id)}/highlights/${encodeURIComponent(hid)}`, sendJson('PUT', body)),
  removeHighlight: (id, hid) => api(`/api/papers/${encodeURIComponent(id)}/highlights/${encodeURIComponent(hid)}`, { method: 'DELETE' }),
  saveCardMemo: (id, cardId, text) => api(`/api/papers/${encodeURIComponent(id)}/card-memos/${encodeURIComponent(cardId)}`, { ...sendJson('PUT', { text }), keepalive: true }),
  resolveNoteConflict: (id, choice) => api(`/api/papers/${encodeURIComponent(id)}/note-conflict`, sendJson('POST', { choice })),
  // Body must be JSON ({}): the server rejects empty bodies. Never throws.
  async authorize() {
    try { return await api('/api/zotero/authorize', sendJson('POST', {})); } catch (err) { return { ok: false, status: 'offline', error: err.message }; }
  },
  // Resolves true only when Zotero accepted the item.
  async register(search, n) {
    try {
      const r = await api('/api/register', sendJson('POST', { search, n }));
      toast(r?.message ?? '등록 요청을 보냈습니다.');
      return r?.ok === true;
    } catch (err) {
      toast(`등록 실패: ${err.message}`);
      return false;
    }
  },
};

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    return parts.map(decodeURIComponent);
  } catch {
    return [];
  }
}

function showError(message) {
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = message;
  const back = document.createElement('a');
  back.href = '#/';
  back.textContent = '← 목록으로';
  app.replaceChildren(p, back);
}

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  dispose?.();
  dispose = null;
  const [kind, name] = parseHash();
  app.setAttribute('aria-busy', 'true');
  try {
    if (kind === 'paper' && name) {
      const data = await api(`/api/papers/${encodeURIComponent(name)}`);
      if (seq !== routeSeq) return;
      document.title = `${data.source?.meta?.title || name} · Paper Reader`;
      dispose = paperView.render(app, { id: name, ...data }, actions) ?? null;
    } else if (kind === 'search' && name) {
      const search = await api(`/api/searches/${encodeURIComponent(name)}`);
      if (seq !== routeSeq) return;
      document.title = `검색 ${name} · Paper Reader`;
      searchView.render(app, { name, search }, actions);
    } else {
      const [papers, searches] = await Promise.all([api('/api/papers'), api('/api/searches')]);
      if (seq !== routeSeq) return;
      document.title = 'Paper Reader';
      listView.render(app, { papers, searches }, actions);
    }
    window.scrollTo(0, 0);
    app.querySelector('h1')?.focus({ preventScroll: true });
  } catch (err) {
    if (seq === routeSeq) showError(`불러오지 못했습니다: ${err.message}`);
  } finally {
    if (seq === routeSeq) app.removeAttribute('aria-busy');
  }
}

window.addEventListener('hashchange', route);
route();
