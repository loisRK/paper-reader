// 세 가지 트렌드(인용 급상승 / 신흥 주제 / 저널 흐름) 선정. 순수 함수만 둔다.

export function monthsBetween(dateStr, now) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 0;
  let m = (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
  if (now.getUTCDate() < d.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

function monthsAgoDate(now, months) {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(now.getUTCDate(), last));
  return t;
}

export function citationMetrics(work, now) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const count = (y) => (work.countsByYear ?? []).find((c) => c.year === y)?.count ?? 0;
  const recentCitations = count(year) + (count(year - 1) * (12 - month)) / 12;
  const velocity = (work.citedBy ?? 0) / Math.max(1, monthsBetween(work.publicationDate, now));
  return { recentCitations, velocity };
}

const round = (n) => Math.round(n * 100) / 100;
const byCited = (a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0);
const isAfter = (w, cutoff) => Boolean(w.publicationDate) && new Date(w.publicationDate) > cutoff;

function note(n, criterion, perTrend) {
  if (n >= 3 || n >= perTrend) return null;
  return n === 0
    ? `조건을 만족하는 저널 원저가 0편입니다(${criterion}).`
    : `조건을 만족하는 저널 원저가 ${n}편뿐이라 ${n}편만 선정했습니다(${criterion}).`;
}

export function selectTrends(works, cfg, now) {
  const { perTrend, emergingWindowMonths, topJournals } = cfg.search;
  const badgesById = new Map();
  const badge = (id, b) => {
    if (!badgesById.has(id)) badgesById.set(id, []);
    if (!badgesById.get(id).includes(b)) badgesById.get(id).push(b);
  };

  // 🔥 citationSurge
  const surge = works
    .filter((w) => monthsBetween(w.publicationDate, now) >= 3 && (w.citedBy ?? 0) >= 1)
    .map((w) => ({ w, ...citationMetrics(w, now) }))
    .sort((a, b) => b.recentCitations - a.recentCitations || b.velocity - a.velocity)
    .slice(0, perTrend)
    .map((x) => x.w);
  surge.forEach((w) => badge(w.openalexId, 'surge'));

  // 🌱 emergingTopics
  const cutoff = monthsAgoDate(now, emergingWindowMonths);
  const withTopic = works.filter((w) => w.topic?.id && w.publicationDate);
  const stats = new Map();
  let R = 0;
  let P = 0;
  for (const w of withTopic) {
    const s = stats.get(w.topic.id) ?? { name: w.topic.name, r: 0, p: 0, recent: [] };
    if (isAfter(w, cutoff)) { s.r++; R++; s.recent.push(w); } else { s.p++; P++; }
    stats.set(w.topic.id, s);
  }
  const K = stats.size;
  const ranked = [...stats.values()]
    .filter((s) => s.r >= 2)
    .map((s) => ({ ...s, growth: ((s.r + 1) / (R + K)) / ((s.p + 1) / (P + K)), isNew: s.p === 0 }))
    .sort((a, b) => b.growth - a.growth);
  const topics = [];
  for (const s of ranked) {
    if (topics.length >= perTrend) break;
    const pick = [...s.recent].sort(byCited)[0];
    topics.push({ name: s.name, growth: round(s.growth), isNew: s.isNew, papers: [pick.openalexId] });
    badge(pick.openalexId, 'emerging');
  }

  // 🏛 journalFlow
  const yearCutoff = monthsAgoDate(now, 12);
  const byJournal = new Map();
  for (const w of works) {
    if (!w.journal || !isAfter(w, yearCutoff)) continue;
    if (!byJournal.has(w.journal)) byJournal.set(w.journal, []);
    byJournal.get(w.journal).push(w);
  }
  const journals = [...byJournal.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, topJournals)
    .map(([name, list]) => {
      const pick = [...list].sort(byCited)[0];
      badge(pick.openalexId, 'journal');
      return { name, count: list.length, papers: [pick.openalexId] };
    });

  return {
    sections: {
      citationSurge: {
        papers: surge.map((w) => w.openalexId),
        note: note(surge.length, '발표 3개월 이상·인용 1회 이상', perTrend),
      },
      emergingTopics: {
        topics,
        note: note(topics.length, `최근 ${emergingWindowMonths}개월 2편 이상인 주제`, perTrend),
      },
      journalFlow: {
        journals,
        note: note(journals.length, '최근 12개월 발표 논문이 있는 저널', topJournals),
      },
    },
    badgesById,
  };
}
