import { el, clear, progressBar } from './dom.js';

export function progressPercent(paper) {
  const total = paper?.cardsTotal ?? 0;
  return total > 0 ? Math.round(((paper.cardsRead ?? 0) / total) * 100) : 0;
}

function paperCard(p) {
  return el('li', { class: 'paper-tile' },
    el('a', { class: 'tile-title', href: `#/paper/${encodeURIComponent(p.id)}`, text: p.title || p.id }),
    el('p', { class: 'tile-meta' }, [p.journal || '저널 정보 없음', p.date].filter(Boolean).join(' · ')),
    el('div', { class: 'tile-progress' },
      progressBar(p.cardsRead, p.cardsTotal, '읽은 카드 비율'),
      el('span', { class: 'tile-count', text: p.cardsTotal > 0 ? `${p.cardsRead}/${p.cardsTotal} 카드 · ${progressPercent(p)}%` : '카드 없음' }),
    ),
    el('span', { class: p.hasDigest ? 'tag tag-ok' : 'tag tag-wait', text: p.hasDigest ? '요약 있음' : '요약 대기' }),
    p.example ? el('span', { class: 'tag tag-example', title: '저장소에 포함된 공개 예제(CC BY) 논문', text: '예제' }) : null,
  );
}

// data: { papers: [...], searches: string[] }
export function render(container, data) {
  clear(container);
  const papers = data.papers ?? [];
  const searches = data.searches ?? [];
  container.append(
    el('h1', { class: 'page-title', tabindex: -1, text: 'Paper Reader' }),
    el('section', { class: 'list-section', 'aria-labelledby': 'h-papers' },
      el('h2', { id: 'h-papers', text: '논문' }),
      papers.length
        ? el('ul', { class: 'tile-list' }, papers.map(paperCard))
        : el('p', { class: 'empty', text: '아직 추출된 논문이 없습니다. npm run extract로 source.json을 만드세요.' }),
    ),
    el('section', { class: 'list-section', 'aria-labelledby': 'h-searches' },
      el('h2', { id: 'h-searches', text: '검색 결과' }),
      searches.length
        ? el('ul', { class: 'link-list' }, searches.map((name) =>
          el('li', {}, el('a', { href: `#/search/${encodeURIComponent(name)}`, text: name }))))
        : el('p', { class: 'empty', text: '저장된 검색 결과가 없습니다. npm run search로 검색하세요.' }),
    ),
  );
}
