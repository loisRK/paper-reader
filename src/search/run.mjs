import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.mjs';
import { searchWorks } from './openalex.mjs';
import { verifyWork } from './verify.mjs';
import { loadMetrics, lookupMetrics } from './metrics.mjs';
import { selectTrends, citationMetrics } from './trends.mjs';

export function slugify(query) {
  return String(query).toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const idsOf = (sections) => [
  ...sections.citationSurge.papers,
  ...sections.emergingTopics.topics.flatMap((t) => t.papers),
  ...sections.journalFlow.journals.flatMap((j) => j.papers),
];

export async function runSearch(query, cfg, deps = {}) {
  const { fetchImpl, now = new Date(), sleep } = deps;
  const search = deps.search ?? ((q, c, o) => searchWorks(q, c, o));
  const verify = deps.verify ?? ((w, c, o) => verifyWork(w, c, o));
  const { perTrend } = cfg.search;

  const works = await search(query, cfg, { fetchImpl, now });
  const byId = new Map(works.map((w) => [w.openalexId, w]));
  const rejected = new Set();
  const cache = new Map(); // openalexId -> verify result
  const limit = perTrend * 3;
  let spent = 0;
  let sel;

  for (;;) {
    sel = selectTrends(works.filter((w) => !rejected.has(w.openalexId)), cfg, now);
    const pending = [...new Set(idsOf(sel.sections))].filter((id) => !cache.has(id));
    if (pending.length === 0) break;
    let stop = false;
    for (const id of pending) {
      if (spent >= limit) { stop = true; break; }
      const r = await verify(byId.get(id), cfg, { fetchImpl, ...(sleep ? { sleep } : {}) });
      spent++;
      cache.set(id, r);
      if (!r.ok) rejected.add(id);
    }
    if (stop) break;
    if (![...pending].some((id) => rejected.has(id))) break;
  }

  // 검증되지 않은(예산 소진) 선정은 제거한다.
  const ok = (id) => cache.get(id)?.ok === true;
  const { sections: s } = sel;
  const sections = {
    citationSurge: { ...s.citationSurge, papers: s.citationSurge.papers.filter(ok) },
    emergingTopics: { ...s.emergingTopics, topics: s.emergingTopics.topics.map((t) => ({ ...t, papers: t.papers.filter(ok) })).filter((t) => t.papers.length) },
    journalFlow: { ...s.journalFlow, journals: s.journalFlow.journals.map((j) => ({ ...j, papers: j.papers.filter(ok) })).filter((j) => j.papers.length) },
  };

  // 번호: citationSurge → emergingTopics → journalFlow 첫 등장 순.
  const numbers = new Map();
  const num = (id) => {
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    return numbers.get(id);
  };
  const out = {
    citationSurge: { papers: sections.citationSurge.papers.map(num), note: sections.citationSurge.note },
    emergingTopics: { topics: sections.emergingTopics.topics.map((t) => ({ ...t, papers: t.papers.map(num) })), note: sections.emergingTopics.note },
    journalFlow: { journals: sections.journalFlow.journals.map((j) => ({ ...j, papers: j.papers.map(num) })), note: sections.journalFlow.note },
  };

  const metricsIndex = deps.metricsIndex ?? (await loadMetrics(cfg));
  const papers = [...numbers.entries()].map(([id, n]) => {
    const w = byId.get(id);
    const { recentCitations, velocity } = citationMetrics(w, now);
    return {
      n,
      ...w,
      recentCitations: Math.round(recentCitations * 100) / 100,
      velocity: Math.round(velocity * 100) / 100,
      badges: sel.badgesById.get(id) ?? [],
      metrics: lookupMetrics(metricsIndex, w.issn),
      verification: cache.get(id).verification,
      summaryKo: null,
    };
  });

  const excluded = [...rejected].map((id) => ({ title: byId.get(id).title, doi: byId.get(id).doi, reason: cache.get(id).reason }));

  const result = {
    query,
    createdAt: now.toISOString(),
    params: { ...{ monthsBack: cfg.search.monthsBack, emergingWindowMonths: cfg.search.emergingWindowMonths, perTrend, topJournals: cfg.search.topJournals }, found: works.length },
    sections: out,
    papers,
    excluded,
  };

  const dir = path.join(cfg.outputDir, '_search');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${now.toISOString().slice(0, 10)}-${slugify(query)}.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2) + '\n');
  return { ...result, path: file };
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('사용법: npm run search -- "<검색어>"');
    process.exit(1);
  }
  const cfg = await loadConfig();
  const r = await runSearch(query, cfg);
  const s = r.sections;
  console.log(`🔥 인용 급상승: ${s.citationSurge.papers.length}편${s.citationSurge.note ? ` (${s.citationSurge.note})` : ''}`);
  console.log(`🌱 신흥 주제: ${s.emergingTopics.topics.length}개${s.emergingTopics.note ? ` (${s.emergingTopics.note})` : ''}`);
  console.log(`🏛 저널 흐름: ${s.journalFlow.journals.length}개${s.journalFlow.note ? ` (${s.journalFlow.note})` : ''}`);
  console.log(`제외: ${r.excluded.length}건`);
  console.log(`저장: ${r.path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
