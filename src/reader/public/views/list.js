import { el, clear, setChildren, progressBar } from './dom.js';
import { jobView, lastLogLine, watchJob } from './digest.js';

export const FOLDER_PREVIEW = 50;

export function progressPercent(paper) {
  const total = paper?.cardsTotal ?? 0;
  return total > 0 ? Math.round(((paper.cardsRead ?? 0) / total) * 100) : 0;
}

// Pure: what a tile shows and offers. Only `state: 'pdf'` items get the extract action.
export function tileState(paper) {
  const zotero = paper?.linked === true;
  if (paper?.state === 'pdf') return { tag: 'PDF만 있음', tagClass: 'tag-pdf', action: 'extract', zotero };
  if (paper?.state === 'digest') return { tag: '요약 있음', tagClass: 'tag-ok', action: 'open', zotero };
  return { tag: '요약 대기', tagClass: 'tag-wait', action: 'open', zotero };
}

// Pure: first FOLDER_PREVIEW items unless expanded.
export function folderPreview(items, expanded) {
  if (expanded || items.length <= FOLDER_PREVIEW) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, FOLDER_PREVIEW), hidden: items.length - FOLDER_PREVIEW };
}

// "PDF 확인 중 (n/m)" while the server is still computing MD5s in the background; null when done.
export function hashingText(hashing) {
  if (!hashing || !(hashing.total > 0) || hashing.done >= hashing.total) return null;
  return `PDF 확인 중 (${hashing.done}/${hashing.total})`;
}

// Pure: everything a list row shows, for both bundles and folder PDFs.
export function rowModel(p) {
  const s = tileState(p);
  const pdf = p?.state === 'pdf';
  const tags = [{ text: s.tag, class: s.tagClass }];
  if (s.zotero && !p.example) tags.push({ text: 'Zotero', class: 'tag-zotero', title: 'Zotero 항목과 연결됨' });
  if (p?.example) tags.push({ text: '예제', class: 'tag-example', title: '저장소에 포함된 공개 예제(CC BY) 논문' });
  const total = p?.cardsTotal ?? 0;
  return {
    title: p?.title || p?.id,
    href: pdf ? null : `#/paper/${encodeURIComponent(p.id)}`,
    meta: pdf ? (p.file ?? '') : [p.journal || '저널 정보 없음', p.date].filter(Boolean).join(' · '),
    count: pdf ? null : (total > 0 ? `${p.cardsRead ?? 0}/${total} 카드` : '카드 없음'),
    showBar: !pdf,
    tags,
    extract: s.action === 'extract',
    digest: (pdf || p?.state === 'extracted') && !p?.example,
  };
}

// One table row (+ a hidden note row for failures). ctx: { onExtract, onDigest, onCancel, onDismiss }.
// cols: 4 for papers (제목·진행·상태·작업), 3 for folder PDFs (파일·상태·작업).
// Returns { nodes, update(job) } — update() keeps the cancel button (and its focus) while a job runs.
function paperRow(p, ctx, cols) {
  const m = rowModel(p);
  const tr = el('tr', { class: 'paper-row', dataset: { id: p.id } });
  const logLine = el('span', { class: 'row-log', hidden: true });
  const titleCell = el('td', { class: 'cell-title', 'data-label': cols === 4 ? '제목' : '파일' },
    m.href
      ? el('a', { class: 'row-title', href: m.href, title: m.title, text: m.title })
      : el('span', { class: 'row-title', title: m.title, text: m.title }),
    m.meta ? el('span', { class: 'row-meta', title: m.meta, text: m.meta }) : null,
    logLine,
  );
  const progressCell = cols === 4
    ? el('td', { class: 'cell-progress', 'data-label': '진행' },
      el('div', { class: 'row-progress' },
        m.showBar ? progressBar(p.cardsRead ?? 0, p.cardsTotal ?? 0, '읽은 카드 비율') : null,
        el('span', { class: 'row-count', text: m.count }),
      ))
    : null;
  const tagCell = el('td', { class: 'cell-tags', 'data-label': '상태' },
    el('div', { class: 'row-tags' }, m.tags.map((t) => el('span', { class: `tag ${t.class}`, title: t.title, text: t.text }))));
  const actionsBox = el('div', { class: 'row-actions' });
  const actionCell = el('td', { class: 'cell-actions', 'data-label': '작업' }, actionsBox);
  tr.append(...[titleCell, progressCell, tagCell, actionCell].filter(Boolean));
  const noteCell = el('td', { colspan: cols });
  const noteTr = el('tr', { class: 'row-note', hidden: true }, noteCell);

  let status = null; // live status span while busy
  const idle = () => {
    status = null;
    const btns = [];
    if (m.extract) {
      const b = el('button', { type: 'button', class: 'btn btn-quiet btn-small extract-btn', text: '추출' });
      b.addEventListener('click', () => ctx.onExtract(p, b));
      btns.push(b);
    }
    if (m.digest) {
      const b = el('button', { type: 'button', class: 'btn btn-small digest-btn', text: '요약 만들기' });
      b.addEventListener('click', () => ctx.onDigest(p, b));
      btns.push(b);
    }
    setChildren(actionsBox, btns);
    actionCell.classList.toggle('is-empty', btns.length === 0);
  };
  const update = (job) => {
    const v = jobView(job);
    if (v?.busy) {
      if (!status) {
        status = el('span', { class: 'row-status', role: 'status' });
        const cancel = el('button', { type: 'button', class: 'btn btn-quiet btn-small cancel-btn', text: '취소' });
        cancel.addEventListener('click', () => ctx.onCancel(p, cancel));
        setChildren(actionsBox, status, cancel);
        actionCell.classList.remove('is-empty');
      }
      status.textContent = v.text;
      status.title = v.text;
      const last = lastLogLine(job);
      logLine.textContent = last;
      logLine.title = last;
      logLine.hidden = !last;
      noteTr.hidden = true;
      tr.classList.add('is-busy');
      return;
    }
    tr.classList.remove('is-busy');
    logLine.hidden = true;
    idle();
    if (v?.tone === 'error') {
      const close = el('button', { type: 'button', class: 'link-btn', text: '닫기' });
      close.addEventListener('click', () => { noteTr.hidden = true; ctx.onDismiss(p); });
      setChildren(noteCell, el('span', { text: v.text }), ' ', close);
      noteTr.hidden = false;
    } else {
      noteTr.hidden = true;
    }
  };
  idle();
  return { nodes: [tr, noteTr], update };
}

function folderSection(folders, actions, hashing) {
  const paths = folders.map((f) => f.path);
  const save = async (next) => {
    try {
      await actions.saveFolders(next);
      await actions.refreshList();
      return true;
    } catch (err) {
      actions.toast(err.message);
      return false;
    }
  };
  const input = el('input', {
    type: 'text', class: 'folder-input', id: 'folder-path', name: 'folder',
    placeholder: '/Users/me/Papers', autocomplete: 'off', spellcheck: 'false',
  });
  const addBtn = el('button', { type: 'submit', class: 'btn btn-small', text: '추가' });
  const refreshBtn = el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: '새로고침' });
  refreshBtn.addEventListener('click', () => actions.refreshList());
  const form = el('form', { class: 'folder-form' },
    el('label', { class: 'sr-only', for: 'folder-path', text: '폴더 경로' }),
    input, addBtn, refreshBtn,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    addBtn.disabled = true;
    const ok = await save([...paths, value]);
    if (!ok) { addBtn.disabled = false; input.focus(); }
  });

  const rows = folders.map((f, i) => {
    const remove = el('button', { type: 'button', class: 'btn btn-quiet btn-small', 'aria-label': `${f.path} 빼기`, text: '빼기' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      if (!(await save(paths.filter((_, j) => j !== i)))) remove.disabled = false;
    });
    return el('li', { class: f.ok ? 'folder-row' : 'folder-row folder-missing' },
      el('div', { class: 'folder-text' },
        el('span', { class: 'folder-path', text: f.path }),
        f.ok
          ? (f.message ? el('span', { class: 'folder-note', text: f.message }) : null)
          : el('span', { class: 'folder-warn', text: '폴더를 찾을 수 없습니다' }),
      ),
      remove,
    );
  });

  return el('section', { class: 'side-section', 'aria-labelledby': 'h-folders' },
    el('h2', { class: 'side-label', id: 'h-folders', text: '논문 폴더' }),
    rows.length
      ? el('ul', { class: 'folder-list' }, rows)
      : el('p', { class: 'side-empty', text: '논문 PDF를 모아 둔 폴더의 경로를 입력하세요.' }),
    hashingText(hashing) ? el('p', { class: 'folder-note', role: 'status', text: hashingText(hashing) }) : null,
    form,
  );
}

const DEFAULT_MODEL_TEXT = '기본값 (계정 플랜에 따라 정해짐)';
const pad2 = (n) => String(n).padStart(2, '0');

/** Two short lines under the tool picker: configured model, and the model the last run reported (local time). */
export function modelLines(agent) {
  const lines = [`설정된 모델: ${agent?.configuredModel || DEFAULT_MODEL_TEXT}`];
  const last = agent?.lastModel;
  if (last?.model) {
    const d = new Date(last.at);
    const when = Number.isNaN(d.getTime()) ? '' : ` · ${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    lines.push(`최근 실행: ${last.model}${when}`);
  }
  return lines;
}

export const profileOptionText = (p) => `${p.label} · ${p.email}`;

// "AI 도구: [Claude Code ▾]" — loads asynchronously (detection runs the tools' --version).
function agentPicker(actions) {
  const box = el('div', { class: 'agent-picker' }, el('span', { class: 'folder-note', text: 'AI 도구 확인 중…' }));
  const section = el('section', { class: 'side-section', 'aria-labelledby': 'h-agent' },
    el('h2', { class: 'side-label', id: 'h-agent', text: 'AI 도구' }), box);
  if (!actions.agents) return section;
  const draw = (info) => {
    const agents = info?.agents ?? [];
    if (!agents.some((a) => a.available)) {
      setChildren(box, el('p', { class: 'folder-note', text: '쓸 수 있는 AI 도구가 없습니다. Claude Code 또는 Codex 중 하나를 설치하고 로그인하면 요약을 만들 수 있습니다.' }));
      return;
    }
    const select = el('select', { id: 'agent-select', class: 'agent-select', name: 'agent' },
      agents.map((a) => el('option', {
        value: a.id,
        disabled: !a.available,
        selected: a.id === info.selected,
        title: a.available ? (a.version ?? null) : (a.message ?? '사용할 수 없습니다'),
        text: a.available ? a.name : `${a.name} (사용 불가)`,
      })));
    // One change handler for both selects: `apply()` saves, redraws, and restores the old value on failure.
    const apply = async (target, prev, call, done) => {
      target.disabled = true;
      try {
        draw(await call());
        actions.toast(done);
      } catch (err) {
        actions.toast(err.message);
        target.value = prev ?? '';
        target.disabled = false;
      }
    };
    select.addEventListener('change', () => apply(select, info.selected, () => actions.selectAgent(select.value), 'AI 도구를 바꿨습니다.'));
    const current = agents.find((a) => a.id === info.selected);
    let account = null;
    if (current?.profiles?.length > 1) {
      const pick = el('select', { id: 'agent-profile', class: 'agent-select', name: 'agent-profile' },
        current.profiles.map((p) => el('option', { value: p.label, selected: p.label === current.selectedProfile, text: profileOptionText(p) })));
      pick.addEventListener('change', () => apply(pick, current.selectedProfile, () => actions.selectAgent(current.id, pick.value), '계정을 바꿨습니다.'));
      account = el('div', { class: 'agent-account' },
        el('label', { class: 'folder-note', for: 'agent-profile', text: '계정' }), pick);
    } else if (current?.profiles?.length === 1) {
      account = el('span', { class: 'folder-note', text: `계정: ${profileOptionText(current.profiles[0])}` });
    }
    setChildren(box,
      el('label', { class: 'sr-only', for: 'agent-select', text: 'AI 도구' }),
      select,
      el('span', { class: 'folder-note', text: '요약 만들기에 쓸 도구입니다.' }),
      account,
      current ? el('div', { class: 'agent-models' }, modelLines(current).map((t) => el('span', { class: 'folder-note', text: t }))) : null,
    );
  };
  actions.agents().then(draw, (err) => setChildren(box, el('p', { class: 'folder-note', text: `AI 도구를 확인하지 못했습니다: ${err.message}` })));
  return section;
}

const PAPER_HEAD = ['제목', '진행', '상태', '작업'];
const PDF_HEAD = ['파일', '상태', '작업'];

function paperTable(items, head, rowFor, label) {
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'paper-table', 'aria-label': label },
      el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { scope: 'col', class: i === head.length - 1 ? 'th-actions' : null, text: h })))),
      el('tbody', {}, items.map((p) => rowFor(p).nodes)),
    ));
}

function pdfSection(pdfs, hasFolders, actions, rowFor, open) {
  let expanded = false;
  let busy = false;
  const section = el('details', { class: 'pdf-section', open: open || null });
  const body = el('div', { class: 'pdf-body' });

  const onExtract = async (p, btn) => {
    if (busy) return;
    busy = true;
    const buttons = [...section.querySelectorAll('.extract-btn')];
    buttons.forEach((b) => { b.disabled = true; });
    btn.textContent = '추출 중…';
    btn.setAttribute('aria-busy', 'true');
    try {
      const r = await actions.extractPaper(p.id);
      if (r?.merged) actions.toast('같은 PDF가 이미 있어 그 논문과 합쳤습니다.');
      await actions.refreshList();
    } catch (err) {
      actions.toast(err.message);
      btn.textContent = '추출';
      btn.removeAttribute('aria-busy');
      buttons.forEach((b) => { b.disabled = false; });
    } finally {
      busy = false;
    }
  };

  const draw = () => {
    const { shown, hidden } = folderPreview(pdfs, expanded);
    let more = null;
    if (hidden > 0) {
      more = el('button', { type: 'button', class: 'btn btn-quiet more-btn', text: `더 보기 (${hidden}개)` });
      more.addEventListener('click', () => { expanded = true; draw(); });
    }
    setChildren(body,
      pdfs.length
        ? paperTable(shown, PDF_HEAD, (p) => rowFor(p, onExtract, 3), '폴더의 PDF')
        : el('p', { class: 'empty', text: hasFolders ? '아직 추출하지 않은 PDF가 없습니다.' : '왼쪽에서 폴더를 추가하면 그 안의 PDF가 여기에 보입니다.' }),
      more,
    );
  };
  section.append(el('summary', {}, el('span', { class: 'pdf-summary', text: `폴더의 PDF (${pdfs.length})` })), body);
  draw();
  return section;
}

// data: { papers: [...], folders: [{ path, ok, message? }], hashing?: { done, total }, searches: string[] }
// actions (digest): agents(), selectAgent(id), startDigest(id), digestJob(id) → job|null,
//   cancelDigest(id), digestTracker { ids, track, untrack }. Returns dispose().
export function render(container, data, actions) {
  clear(container);
  const all = data.papers ?? [];
  const papers = all.filter((p) => p.state !== 'pdf');
  const pdfs = all.filter((p) => p.state === 'pdf');
  const folders = data.folders ?? [];
  const searches = data.searches ?? [];

  // ---- digest jobs: rows by paper id, one 2 s poller per tracked id while it runs ----
  const rows = new Map();
  const lastJobs = new Map();
  const watchers = new Map();
  const tracker = actions.digestTracker;
  let disposed = false;

  const showJob = (id, job) => {
    lastJobs.set(id, job);
    rows.get(id)?.update(job);
    if (job?.paperId && job.paperId !== id) { lastJobs.set(job.paperId, job); rows.get(job.paperId)?.update(job); }
  };
  const watch = (id, seenBusy = false) => {
    if (disposed || !actions.digestJob) return;
    watchers.get(id)?.stop();
    let sawBusy = seenBusy;
    const w = watchJob({
      id,
      actions,
      onUpdate(job) {
        if (disposed || watchers.get(id) !== w) return; // stale poll from a replaced watcher
        if (!job) { tracker?.untrack(id); return; }
        showJob(id, job);
        const v = jobView(job);
        if (v?.busy) { sawBusy = true; return; }
        watchers.delete(id);
        const wasTracked = tracker?.ids().includes(id);
        if (job.state !== 'failed') tracker?.untrack(id);
        if (sawBusy) {
          // Finished while we watched: say so (failures stay as a row note) and reload the list.
          if (job.state !== 'failed') actions.toast(v.text);
          actions.refreshList();
        } else if (job.state === 'done' && wasTracked) {
          actions.refreshList(); // finished while the list was not open
        }
      },
    });
    watchers.set(id, w);
    w.start();
  };
  const digestCtx = {
    async onDigest(p, btn) {
      btn.disabled = true;
      try {
        const job = await actions.startDigest(p.id);
        tracker?.track(p.id);
        showJob(p.id, job);
        watch(p.id, true);
      } catch (err) {
        actions.toast(err.message);
        btn.disabled = false;
        // Another tab may already be making this very paper's digest: pick up its progress.
        if (err.status === 409) watch(p.id);
      }
    },
    async onCancel(p, btn) {
      btn.disabled = true;
      try {
        await actions.cancelDigest(p.id);
      } catch (err) {
        actions.toast(err.message);
        btn.disabled = false;
      }
    },
    onDismiss(p) { tracker?.untrack(p.id); lastJobs.delete(p.id); },
  };
  const rowFor = (p, onExtract = () => {}, cols = 4) => {
    const row = paperRow(p, { ...digestCtx, onExtract }, cols);
    rows.set(p.id, row);
    if (lastJobs.has(p.id)) row.update(lastJobs.get(p.id));
    return row;
  };

  document.body.classList.add('home-mode');
  const sidebar = el('aside', { class: 'home-side', 'aria-label': '설정' },
    el('h1', { class: 'side-title', tabindex: -1, text: 'Paper Reader' }),
    folderSection(folders, actions, data.hashing),
    agentPicker(actions),
    el('section', { class: 'side-section', 'aria-labelledby': 'h-searches' },
      el('h2', { class: 'side-label', id: 'h-searches', text: '검색 결과' }),
      searches.length
        ? el('ul', { class: 'side-links' }, searches.map((name) =>
          el('li', {}, el('a', { href: `#/search/${encodeURIComponent(name)}`, text: name }))))
        : el('p', { class: 'side-empty', text: '저장된 검색 결과가 없습니다. npm run search로 검색하세요.' }),
    ),
  );
  const main = el('section', { class: 'home-main', 'aria-labelledby': 'h-papers' },
    el('div', { class: 'main-head' },
      el('h2', { id: 'h-papers', class: 'main-title', text: '논문' }),
      el('span', { class: 'main-count', text: `${papers.length}편` }),
    ),
    papers.length
      ? paperTable(papers, PAPER_HEAD, (p) => rowFor(p), '추출된 논문')
      : el('div', { class: 'main-empty' },
        el('p', { text: '아직 추출된 논문이 없습니다.' }),
        el('p', { class: 'muted', text: '왼쪽 "논문 폴더"에 PDF가 있는 폴더 경로를 추가한 뒤, 아래 "폴더의 PDF"에서 추출하거나 요약을 만드세요.' }),
      ),
    pdfSection(pdfs, folders.length > 0, actions, rowFor, papers.length === 0),
  );
  container.append(el('div', { class: 'home' }, sidebar, main));

  for (const id of tracker?.ids() ?? []) watch(id);

  return () => {
    disposed = true;
    document.body.classList.remove('home-mode');
    for (const w of watchers.values()) w.stop();
    watchers.clear();
  };
}
