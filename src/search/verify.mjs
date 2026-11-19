import { fetchJson, HttpError } from '../http.mjs';

const CONFERENCE_RE = /proceedings|conference|symposium|workshop/i;

// "03029743" / "0302-9743" / "0302-974x" -> "0302-9743" / "0302-974X"
export function normalizeIssn(issn) {
  const s = String(issn ?? '').replace(/[^0-9xX]/g, '').toUpperCase();
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : String(issn ?? '').trim().toUpperCase();
}

export async function verifyWork(work, cfg, opts = {}) {
  const { fetchImpl = globalThis.fetch, sleep } = opts;
  const verification = { crossrefType: null, doiResolves: null };
  const fail = (reason) => ({ ok: false, reason, verification });

  if (!work?.doi) return fail('DOI 없음');
  const doi = work.doi;

  try {
    let message;
    try {
      const body = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi).replace(/%2F/gi, '/')}`, { fetchImpl, ...(sleep ? { sleep } : {}) });
      message = body?.message ?? {};
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return fail('Crossref에 등록되지 않은 DOI');
      throw err;
    }

    verification.crossrefType = message.type ?? null;
    if (message.type !== 'journal-article') return fail(`Crossref 유형: ${message.type}`);

    const issns = (message.ISSN ?? []).map(normalizeIssn);
    if (issns.length === 0) return fail('ISSN 없음');

    const excluded = new Set((cfg.search?.excludedIssns ?? []).map(normalizeIssn));
    const hit = issns.find((i) => excluded.has(i));
    if (hit) return fail(`학회 proceedings 시리즈(${hit})`);

    if ((message['container-title'] ?? []).some((t) => CONFERENCE_RE.test(t))) return fail('학회 proceedings로 보임');

    const res = await fetchImpl(`https://doi.org/${doi}`, { method: 'HEAD', redirect: 'manual' });
    const location = res.headers?.get?.('location');
    const resolves = res.status >= 300 && res.status < 400 && Boolean(location);
    verification.doiResolves = resolves;
    if (!resolves) return fail('DOI가 출판사 페이지로 연결되지 않음');

    return { ok: true, reason: null, verification };
  } catch (err) {
    return fail(`확인 실패: ${err.message}`);
  }
}
