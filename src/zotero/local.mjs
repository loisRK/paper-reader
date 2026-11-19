import crypto from 'node:crypto';

export const NOT_RUNNING_MESSAGE = 'Zotero가 실행 중이 아닙니다. Zotero를 켠 뒤 다시 실행하세요.';
export const NO_PDF_MESSAGE = 'PDF 없음: 기관 구독으로 PDF를 받아 Zotero 항목에 넣어주세요.';

const baseUrl = (cfg) => String(cfg.zotero.baseUrl).replace(/\/+$/, '');

export function splitCreator(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return { lastName: parts[0] ?? '', firstName: '', creatorType: 'author' };
  const lastName = parts.pop();
  return { firstName: parts.join(' '), lastName, creatorType: 'author' };
}

export async function zoteroRunning(cfg, opts = {}) {
  const { fetchImpl = globalThis.fetch } = opts;
  try {
    const res = await fetchImpl(`${baseUrl(cfg)}/connector/ping`);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function registerPaper(paper, cfg, opts = {}) {
  const { fetchImpl = globalThis.fetch } = opts;
  const doiUrl = `https://doi.org/${paper.doi}`;
  const body = {
    sessionID: crypto.randomUUID(),
    uri: doiUrl,
    items: [{
      itemType: 'journalArticle',
      title: paper.title,
      creators: (paper.authors ?? []).map(splitCreator),
      publicationTitle: paper.journal,
      date: paper.publicationDate,
      DOI: paper.doi,
      ISSN: (paper.issn ?? []).join(', '),
      url: doiUrl,
      attachments: paper.oaPdfUrl
        ? [{ title: 'Full Text PDF', url: paper.oaPdfUrl, mimeType: 'application/pdf' }]
        : [],
    }],
  };
  let res;
  try {
    res = await fetchImpl(`${baseUrl(cfg)}/connector/saveItems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, pdfAttached: false, message: NOT_RUNNING_MESSAGE };
  }
  if (res.status !== 201) {
    return { ok: false, pdfAttached: false, message: `Zotero 등록 실패: HTTP ${res.status}` };
  }
  const pdfAttached = Boolean(paper.oaPdfUrl);
  return {
    ok: true,
    pdfAttached,
    message: pdfAttached ? '등록 완료 (OA PDF 첨부 요청됨)' : NO_PDF_MESSAGE,
  };
}
