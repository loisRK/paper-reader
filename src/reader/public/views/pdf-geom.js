// PDF 좌표 순수 함수. 브라우저와 서버가 함께 쓰므로 DOM·Node 의존이 없다.
// PDF 사용자 좌표: 왼쪽 아래 원점, 사각형은 [x0, y0, x1, y1].

// A sentence matches when the overlap covers >= 30% of one selected rect,
// or >= 50% of the sentence's own area (a line-wide rect over several short sentences).
const MATCH_THRESHOLD = 0.3;
const SENTENCE_THRESHOLD = 0.5;

const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite);
const seqOf = (id) => Number(/-s(\d+)$/.exec(id)?.[1] ?? Infinity);
const area = ([x1, y1, x2, y2]) => Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
function overlap(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function pageSentenceIds(page, source) {
  return Object.keys(source?.sentences ?? {})
    .filter((id) => source.sentences[id].page === page && Array.isArray(source.sentences[id].pdfRects))
    .sort((a, b) => seqOf(a) - seqOf(b));
}

// PDF 좌표 사각형들 -> 걸친 문장 ID (문장 순서).
export function matchRects(rects, page, source) {
  const sel = (Array.isArray(rects) ? rects : []).filter(isRect);
  if (!sel.length) return [];
  return pageSentenceIds(page, source).filter((id) => {
    const sr = source.sentences[id].pdfRects.filter(isRect);
    const sa = sr.reduce((sum, r) => sum + area(r), 0);
    let total = 0;
    for (const ar of sel) {
      const aa = area(ar);
      if (!aa) continue;
      const ov = sr.reduce((sum, r) => sum + overlap(ar, r), 0);
      if (ov / aa >= MATCH_THRESHOLD) return true;
      total += ov;
    }
    return sa > 0 && Math.min(total, sa) / sa >= SENTENCE_THRESHOLD;
  });
}

// 쪽 요소 기준 화면 사각형 -> PDF 사각형. 너비·높이 0은 버린다.
export function clientRectsToPdf(rects, pageBox, viewport) {
  const out = [];
  for (const r of rects) {
    const [ax, ay] = viewport.convertToPdfPoint(r.left - pageBox.left, r.top - pageBox.top);
    const [bx, by] = viewport.convertToPdfPoint(r.right - pageBox.left, r.bottom - pageBox.top);
    const rect = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    if (rect[2] - rect[0] > 0 && rect[3] - rect[1] > 0) out.push(rect);
  }
  return out;
}

// PDF 사각형 -> 쪽 요소 안 CSS 픽셀 위치.
export function pdfRectToCss(rect, viewport) {
  const [a, b, c, d] = viewport.convertToViewportRectangle(rect);
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

// PDF 좌표 점을 포함하는 문장. sids(배열/Set)가 있으면 그 안에서만 찾는다.
export function sentenceAtPoint(x, y, page, source, sids) {
  const allowed = sids ? new Set(sids) : null;
  const hit = pageSentenceIds(page, source).find((id) => (!allowed || allowed.has(id))
    && source.sentences[id].pdfRects.some((r) => isRect(r) && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]));
  return hit ?? null;
}
