// reader 문장 <-> Zotero annotation 변환·매칭 (순수 함수, I/O 없음)

export const ZOTERO_COLORS = {
  yellow: '#ffd400', red: '#ff6666', green: '#5fb236', blue: '#2ea8e5',
  purple: '#a28ae5', magenta: '#e56eee', orange: '#f19837', gray: '#aaaaaa',
};
export const TAG = 'paper-reader';
const DEFAULT_COLOR = ZOTERO_COLORS.yellow;
const MATCH_THRESHOLD = 0.3;

const pad = (n, w) => String(Math.max(0, Math.trunc(n) || 0)).padStart(w, '0');

export function sortIndex(pageIndex, charOffset, top) {
  return `${pad(pageIndex, 5)}|${pad(charOffset, 6)}|${pad(top, 5)}`;
}

const seqOf = (id) => Number(/-s(\d+)$/.exec(id)?.[1] ?? Infinity);

export function toZoteroAnnotation({ sentenceIds, color, comment }, source, attachmentKey) {
  const sentences = sentenceIds.map((id) => {
    const s = source.sentences[id];
    if (!s) throw new Error(`알 수 없는 문장: ${id}`);
    return { id, ...s };
  });
  if (!sentences.length) throw new Error('문장이 없습니다.');
  const page = sentences[0].page;
  if (sentences.some((s) => s.page !== page)) {
    throw new Error('한 하이라이트는 한 페이지 안의 문장만 담을 수 있습니다.');
  }
  if (sentences.some((s) => !Array.isArray(s.pdfRects) || !s.pdfRects.length)) {
    throw new Error('NEEDS_REEXTRACT');
  }
  const rects = sentences.flatMap((s) => s.pdfRects);

  // 같은 페이지에서 첫 선택 문장보다 앞선 문장들의 text 길이 합
  const firstSeq = Math.min(...sentences.map((s) => seqOf(s.id)));
  let charOffset = 0;
  for (const [id, s] of Object.entries(source.sentences)) {
    if (s.page === page && seqOf(id) < firstSeq) charOffset += (s.text ?? '').length;
  }
  // top: MuPDF rects(top-left 원점)의 최소 y0
  const y0s = sentences.flatMap((s) => (s.rects ?? []).map((r) => r[1]));
  const top = y0s.length ? Math.max(0, Math.floor(Math.min(...y0s))) : 0;

  return {
    itemType: 'annotation',
    parentItem: attachmentKey,
    annotationType: 'highlight',
    annotationText: sentences.map((s) => s.text).join(' '),
    annotationComment: comment ?? '',
    annotationColor: color || DEFAULT_COLOR,
    annotationPageLabel: String(page),
    annotationSortIndex: sortIndex(page - 1, charOffset, top),
    annotationPosition: JSON.stringify({ pageIndex: page - 1, rects }),
    tags: [{ tag: TAG }],
  };
}

const area = ([x1, y1, x2, y2]) => Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
function overlap(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export function matchSentences(annotationData, source) {
  let pos;
  try {
    const raw = annotationData?.annotationPosition;
    pos = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { page: 0, sentenceIds: [] };
  }
  if (!pos || !Number.isInteger(pos.pageIndex)) return { page: 0, sentenceIds: [] };
  const page = pos.pageIndex + 1;
  const rects = Array.isArray(pos.rects) ? pos.rects.filter((r) => Array.isArray(r) && r.length === 4) : [];
  if (!rects.length) return { page, sentenceIds: [] };

  const ids = Object.keys(source.sentences)
    .filter((id) => source.sentences[id].page === page && Array.isArray(source.sentences[id].pdfRects))
    .sort((a, b) => seqOf(a) - seqOf(b));
  const sentenceIds = ids.filter((id) => {
    const sr = source.sentences[id].pdfRects;
    return rects.some((ar) => {
      const aa = area(ar);
      if (!aa) return false;
      const ov = sr.reduce((sum, r) => sum + overlap(ar, r), 0);
      return ov / aa >= MATCH_THRESHOLD;
    });
  });
  return { page, sentenceIds };
}

export function isMine(item) {
  const tags = item?.tags ?? item?.data?.tags ?? [];
  return tags.some((t) => (typeof t === 'string' ? t : t?.tag) === TAG);
}
