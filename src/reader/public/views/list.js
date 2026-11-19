import { el, clear, setChildren, progressBar } from './dom.js';

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

const zoteroTag = () => el('span', { class: 'tag tag-zotero', title: 'Zotero 항목과 연결됨', text: 'Zotero' });

// "PDF 확인 중 (n/m)" while the server is still computing MD5s in the background; null when done.
export function hashingText(hashing) {
  if (!hashing || !(hashing.total > 0) || hashing.done >= hashing.total) return null;
  return `PDF 확인 중 (${hashing.done}/${hashing.total})`;
}

function paperCard(p) {
  const s = tileState(p);
  return el('li', { class: 'paper-tile' },
    el('a', { class: 'tile-title', href: `#/paper/${encodeURIComponent(p.id)}`, text: p.title || p.id }),
    el('p', { class: 'tile-meta' }, [p.journal || '저널 정보 없음', p.date].filter(Boolean).join(' · ')),
    el('div', { class: 'tile-progress' },
      progressBar(p.cardsRead ?? 0, p.cardsTotal ?? 0, '읽은 카드 비율'),
      el('span', { class: 'tile-count', text: p.cardsTotal > 0 ? `${p.cardsRead}/${p.cardsTotal} 카드 · ${progressPercent(p)}%` : '카드 없음' }),
    ),
    el('span', { class: `tag ${s.tagClass}`, text: s.tag }),
    s.zotero && !p.example ? zoteroTag() : null,
    p.example ? el('span', { class: 'tag tag-example', title: '저장소에 포함된 공개 예제(CC BY) 논문', text: '예제' }) : null,
  );
}

function pdfCard(p, onExtract) {
  const s = tileState(p);
  const btn = s.action === 'extract'
    ? el('button', { type: 'button', class: 'btn extract-btn', text: '추출' })
    : null;
  btn?.addEventListener('click', () => onExtract(p, btn));
  return el('li', { class: 'paper-tile pdf-tile' },
    el('p', { class: 'tile-title', text: p.title || p.id }),
    p.file && p.file !== p.title ? el('p', { class: 'tile-path', text: p.file }) : null,
    el('div', { class: 'tile-actions' },
      el('span', { class: `tag ${s.tagClass}`, text: s.tag }),
      btn,
    ),
  );
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
  const addBtn = el('button', { type: 'submit', class: 'btn', text: '추가' });
  const refreshBtn = el('button', { type: 'button', class: 'btn btn-quiet', text: '새로고침' });
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

  return el('section', { class: 'list-section folder-section', 'aria-labelledby': 'h-folders' },
    el('h2', { id: 'h-folders', text: '논문 폴더' }),
    rows.length
      ? el('ul', { class: 'folder-list' }, rows)
      : el('p', { class: 'empty', text: '논문 PDF를 모아 둔 폴더의 경로를 입력하세요. 예: /Users/me/Papers' }),
    hashingText(hashing) ? el('p', { class: 'folder-note', role: 'status', text: hashingText(hashing) }) : null,
    form,
  );
}

function pdfSection(pdfs, hasFolders, actions) {
  let expanded = false;
  let busy = false;
  const section = el('section', { class: 'list-section', 'aria-labelledby': 'h-pdfs' });

  const onExtract = async (p, btn) => {
    if (busy) return;
    busy = true;
    const buttons = [...section.querySelectorAll('.extract-btn')];
    buttons.forEach((b) => { b.disabled = true; });
    btn.textContent = '추출 중…';
    btn.setAttribute('aria-busy', 'true');
    try {
      await actions.extractPaper(p.id);
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
    setChildren(section,
      el('h2', { id: 'h-pdfs', text: '폴더의 PDF' }),
      pdfs.length
        ? el('ul', { class: 'tile-list' }, shown.map((p) => pdfCard(p, onExtract)))
        : el('p', { class: 'empty', text: hasFolders ? '아직 추출하지 않은 PDF가 없습니다.' : '폴더를 추가하면 그 안의 PDF가 여기에 보입니다.' }),
      more,
    );
  };
  draw();
  return section;
}

// data: { papers: [...], folders: [{ path, ok, message? }], hashing?: { done, total }, searches: string[] }
export function render(container, data, actions) {
  clear(container);
  const all = data.papers ?? [];
  const papers = all.filter((p) => p.state !== 'pdf');
  const pdfs = all.filter((p) => p.state === 'pdf');
  const folders = data.folders ?? [];
  const searches = data.searches ?? [];
  container.append(
    el('h1', { class: 'page-title', tabindex: -1, text: 'Paper Reader' }),
    folderSection(folders, actions, data.hashing),
    el('section', { class: 'list-section', 'aria-labelledby': 'h-papers' },
      el('h2', { id: 'h-papers', text: '요약 있음 · 대기' }),
      papers.length
        ? el('ul', { class: 'tile-list' }, papers.map(paperCard))
        : el('p', { class: 'empty', text: '아직 추출된 논문이 없습니다. 아래 폴더의 PDF에서 추출하거나 npm run extract를 쓰세요.' }),
    ),
    pdfSection(pdfs, folders.length > 0, actions),
    el('section', { class: 'list-section', 'aria-labelledby': 'h-searches' },
      el('h2', { id: 'h-searches', text: '검색 결과' }),
      searches.length
        ? el('ul', { class: 'link-list' }, searches.map((name) =>
          el('li', {}, el('a', { href: `#/search/${encodeURIComponent(name)}`, text: name }))))
        : el('p', { class: 'empty', text: '저장된 검색 결과가 없습니다. npm run search로 검색하세요.' }),
    ),
  );
}
