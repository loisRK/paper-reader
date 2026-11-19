import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const NOT_RUNNING_MESSAGE = 'Zotero가 실행 중이 아닙니다. Zotero를 켠 뒤 다시 실행하세요.';
export const NO_PDF_MESSAGE = 'PDF 없음: 기관 구독으로 PDF를 받아 Zotero 항목에 넣어주세요.';

export const NO_PDF_MESSAGE_READ = '이 항목에 PDF 첨부가 없습니다. PDF를 Zotero에 넣은 뒤 다시 실행하세요.';

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

const ITEM_KEY_RE = /^[A-Z0-9]{8}$/;

// Not NFC-normalized on purpose: must match the bytes on disk.
export function fileUrlToLocalPath(url) {
  return fileURLToPath(url);
}

async function zget(cfg, fetchImpl, pathAndQuery) {
  try {
    return await fetchImpl(`${baseUrl(cfg)}/api/users/0/${pathAndQuery}`);
  } catch {
    throw new Error(NOT_RUNNING_MESSAGE);
  }
}

function toMeta(d) {
  return {
    title: d.title ?? '',
    authors: (d.creators ?? []).map((c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')),
    journal: d.publicationTitle ?? '',
    date: d.date ?? '',
    doi: d.DOI ?? '',
  };
}

// idOrKey: 8-char Zotero item key, citation key, or DOI (starts with "10.").
export async function resolveItem(idOrKey, cfg, opts = {}) {
  const { fetchImpl = globalThis.fetch } = opts;
  const notFound = new Error(`Zotero에서 '${idOrKey}' 항목을 찾지 못했습니다.`);
  let item;
  if (ITEM_KEY_RE.test(idOrKey)) {
    const res = await zget(cfg, fetchImpl, `items/${idOrKey}?format=json`);
    if (res.status === 404) throw notFound;
    if (!res.ok) throw new Error(`Zotero 조회 실패: HTTP ${res.status}`);
    item = await res.json();
  } else {
    const res = await zget(cfg, fetchImpl, `items?q=${encodeURIComponent(idOrKey)}&qmode=everything&format=json`);
    if (!res.ok) throw new Error(`Zotero 조회 실패: HTTP ${res.status}`);
    const list = await res.json();
    const isDoi = /^10\./.test(idOrKey);
    const want = idOrKey.toLowerCase();
    item = (Array.isArray(list) ? list : []).find((it) => (isDoi
      ? String(it?.data?.DOI ?? '').toLowerCase() === want
      : it?.data?.citationKey === idOrKey));
    if (!item) throw notFound;
  }
  const itemKey = item.key;
  const kids = await zget(cfg, fetchImpl, `items/${itemKey}/children?format=json`);
  if (!kids.ok) throw new Error(`Zotero 조회 실패: HTTP ${kids.status}`);
  const att = ((await kids.json()) ?? []).find((c) => c?.data?.contentType === 'application/pdf');
  if (!att) throw new Error(NO_PDF_MESSAGE_READ);
  const fileRes = await zget(cfg, fetchImpl, `items/${att.key}/file/view/url`);
  if (!fileRes.ok) throw new Error(NO_PDF_MESSAGE_READ);
  const pdfPath = fileUrlToLocalPath((await fileRes.text()).trim());
  return {
    id: item.data.citationKey || itemKey,
    itemKey,
    attachmentKey: att.key,
    pdfPath,
    meta: toMeta(item.data),
  };
}
