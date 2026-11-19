import { fetchJson } from '../http.mjs';

const BASE = 'https://api.openalex.org/works';
const PER_PAGE = 200;

function monthsAgo(now, months) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

function rebuildAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  return words.filter((w) => w !== undefined).join(' ');
}

export function normalizeWork(raw) {
  const source = raw.primary_location?.source ?? null;
  const topic = raw.primary_topic;
  return {
    openalexId: raw.id,
    doi: raw.doi ? raw.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null,
    title: raw.title ?? raw.display_name ?? '',
    abstract: rebuildAbstract(raw.abstract_inverted_index),
    authors: (raw.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    journal: source?.display_name ?? null,
    issn: source?.issn ?? [],
    publicationDate: raw.publication_date ?? null,
    citedBy: raw.cited_by_count ?? 0,
    countsByYear: (raw.counts_by_year ?? []).map((c) => ({ year: c.year, count: c.cited_by_count })),
    topic: topic ? { id: topic.id, name: topic.display_name } : null,
    oaPdfUrl: raw.best_oa_location?.pdf_url ?? null,
  };
}

export async function searchWorks(query, cfg, opts = {}) {
  const { fetchImpl, now = new Date(), sleep } = opts;
  const { monthsBack, maxResults, openalexApiKey, contactEmail } = cfg.search;
  const filter = [
    'type:article',
    'primary_location.source.type:journal',
    'is_retracted:false',
    `from_publication_date:${monthsAgo(now, monthsBack)}`,
  ].join(',');

  const works = [];
  let cursor = '*';
  while (cursor && works.length < maxResults) {
    const params = new URLSearchParams({ search: query, filter, 'per-page': String(PER_PAGE), cursor });
    if (openalexApiKey) params.set('api_key', openalexApiKey);
    if (contactEmail) params.set('mailto', contactEmail);
    const page = await fetchJson(`${BASE}?${params}`, { fetchImpl, ...(sleep ? { sleep } : {}) });
    const results = page.results ?? [];
    if (results.length === 0) break;
    for (const r of results) works.push(normalizeWork(r));
    cursor = page.meta?.next_cursor ?? null;
  }
  return works.slice(0, maxResults);
}
