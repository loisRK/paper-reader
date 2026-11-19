import { el, clear } from './dom.js';

// Verified metrics become solid badges; unverifiable ones (null) become "… 미확인".
export function metricBadges(metrics) {
  const m = metrics ?? {};
  const out = [];
  out.push(m.scopus ? { label: 'Scopus', unverified: false } : { label: 'Scopus 미확인', unverified: true });
  out.push(m.sjrQuartile
    ? { label: `SJR ${m.sjrQuartile}${m.sjrYear ? ` (${m.sjrYear})` : ''}`, unverified: false }
    : { label: 'Q 미확인', unverified: true });
  out.push(m.wos ? { label: 'WoS', unverified: false } : { label: 'WoS 미확인', unverified: true });
  if (m.scie) out.push({ label: 'SCIE', unverified: false });
  if (m.ssci) out.push({ label: 'SSCI', unverified: false });
  if (!m.scie && !m.ssci) out.push({ label: 'SCIE 미확인', unverified: true });
  return out;
}

function paperCard(p, searchName, actions) {
  const btn = el('button', { type: 'button', class: 'btn', text: 'Zotero에 등록' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await actions.register(searchName, p.n);
    } finally {
      btn.disabled = false;
    }
  });
  const meta = [p.journal || '저널 정보 없음', p.publicationDate, `인용 ${p.citedBy ?? 0}회`].filter(Boolean).join(' · ');
  return el('li', { class: 'result' },
    el('div', { class: 'result-head' },
      el('span', { class: 'result-num', text: String(p.n) }),
      el('h3', { class: 'result-title', text: p.title || '(제목 없음)' }),
    ),
    p.summaryKo
      ? el('p', { class: 'result-summary', text: p.summaryKo })
      : el('p', { class: 'result-summary pending', text: '요약 대기' }),
    el('p', { class: 'result-meta', text: meta }),
    el('ul', { class: 'badges', 'aria-label': '저널 지표' },
      metricBadges(p.metrics).map((b) => el('li', { class: b.unverified ? 'badge unverified' : 'badge', text: b.label }))),
    el('div', { class: 'result-actions' },
      p.doi ? el('a', { href: `https://doi.org/${p.doi}`, target: '_blank', rel: 'noopener noreferrer', text: `DOI ${p.doi}` }) : null,
      btn,
    ),
  );
}

function papersList(ns, byN, searchName, actions) {
  const items = (ns ?? []).map((n) => byN.get(n)).filter(Boolean);
  if (!items.length) return null;
  return el('ol', { class: 'result-list' }, items.map((p) => paperCard(p, searchName, actions)));
}

function section(id, title, sec, body) {
  return el('section', { class: 'trend', 'aria-labelledby': id },
    el('h2', { id, text: title }),
    sec?.note ? el('p', { class: 'note', text: sec.note }) : null,
    body.filter(Boolean).length ? body : el('p', { class: 'empty', text: '해당 논문이 없습니다.' }),
  );
}

// data: { name, search } ; actions: { register(searchName, n) }
export function render(container, data, actions) {
  clear(container);
  const s = data.search ?? {};
  const byN = new Map((s.papers ?? []).map((p) => [p.n, p]));
  const secs = s.sections ?? {};
  const surge = secs.citationSurge ?? {};
  const emerging = secs.emergingTopics ?? {};
  const flow = secs.journalFlow ?? {};
  const excluded = s.excluded ?? [];

  container.append(
    el('p', { class: 'crumb' }, el('a', { href: '#/', text: '← 목록' })),
    el('h1', { class: 'page-title', tabindex: -1, text: s.query ? `검색: ${s.query}` : data.name }),
    s.createdAt ? el('p', { class: 'muted', text: `검색 시각 ${s.createdAt}` }) : null,
    section('h-surge', '🔥 인용 급증', surge, [papersList(surge.papers, byN, data.name, actions)]),
    section('h-emerging', '🌱 새 주제', emerging, (emerging.topics ?? []).map((t) => el('div', { class: 'group' },
      el('h3', { class: 'group-title' },
        t.name,
        t.isNew ? el('span', { class: 'tag tag-ok', text: '새 주제' }) : null,
        typeof t.growth === 'number' ? el('span', { class: 'muted', text: ` 성장 ×${t.growth}` }) : null),
      papersList(t.papers, byN, data.name, actions)))),
    section('h-flow', '🏛 저널 흐름', flow, (flow.journals ?? []).map((j) => el('div', { class: 'group' },
      el('h3', { class: 'group-title' }, j.name, el('span', { class: 'muted', text: ` ${j.count ?? 0}편` })),
      papersList(j.papers, byN, data.name, actions)))),
    excluded.length
      ? el('details', { class: 'excluded' },
        el('summary', { text: `제외된 후보 (${excluded.length})` }),
        el('ul', {}, excluded.map((x) => el('li', {},
          el('span', { text: x.title || x.doi || '(제목 없음)' }),
          el('span', { class: 'muted', text: ` — ${x.reason ?? ''}` })))))
      : null,
  );
}
