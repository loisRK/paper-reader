import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRects, clientRectsToPdf, pdfRectToCss, sentenceAtPoint } from '../src/reader/public/views/pdf-geom.js';
import { matchSentences } from '../src/zotero/annotations.mjs';

// PDF.js PageViewport transform stub: view box [x0,y0,x1,y1], scale s, rotation 0|90.
function makeViewport(view, scale, rotation) {
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
  const w = x1 - x0; const h = y1 - y0;
  let m; let width; let height;
  if (rotation === 0) { m = [scale, 0, 0, -scale, -scale * x0, scale * y1]; width = w * scale; height = h * scale; }
  else if (rotation === 90) { m = [0, scale, scale, 0, -scale * y0, -scale * x0]; width = h * scale; height = w * scale; }
  else throw new Error('rotation');
  void cx; void cy;
  const apply = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return {
    width, height,
    convertToViewportRectangle([ax, ay, bx, by]) { return [...apply(ax, ay), ...apply(bx, by)]; },
    convertToPdfPoint(x, y) {
      const det = m[0] * m[3] - m[1] * m[2];
      const dx = x - m[4]; const dy = y - m[5];
      return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
    },
  };
}

const source = {
  sentences: {
    'p1-s1': { page: 1, text: 'A', pdfRects: [[50, 688, 300, 700]] },
    'p1-s2': { page: 1, text: 'B', pdfRects: [[50, 668, 200, 680]] },
    'p1-s3': { page: 1, text: 'C', pdfRects: [[50, 488, 100, 500]] },
    'p1-s10': { page: 1, text: 'D', pdfRects: [[320, 688, 400, 700]] },
    'p1-old': { page: 1, text: 'old' },
    'p2-s1': { page: 2, text: 'E', pdfRects: [[50, 688, 300, 700]] },
  },
};

const cases = [
  ['rot0 scale1.5', [0, 0, 600, 800], 1.5, 0],
  ['rot90 scale2', [0, 0, 600, 800], 2, 90],
  ['cropbox offset rot0', [20, 30, 580, 780], 1.25, 0],
  ['cropbox offset rot90', [20, 30, 580, 780], 1.25, 90],
];

for (const [name, view, scale, rot] of cases) {
  test(`round trip PDF -> CSS -> PDF within 0.5pt (${name})`, () => {
    const vp = makeViewport(view, scale, rot);
    const pdf = [100, 200, 260, 214];
    const css = pdfRectToCss(pdf, vp);
    assert.ok(css.width > 0 && css.height > 0);
    const pageBox = { left: 10, top: 5 };
    const back = clientRectsToPdf(
      [{ left: pageBox.left + css.left, top: pageBox.top + css.top, right: pageBox.left + css.left + css.width, bottom: pageBox.top + css.top + css.height }],
      pageBox, vp,
    );
    assert.equal(back.length, 1);
    back[0].forEach((v, i) => assert.ok(Math.abs(v - pdf[i]) <= 0.5, `${v} vs ${pdf[i]}`));
  });
}

test('pdfRectToCss for rot0 flips y', () => {
  const vp = makeViewport([0, 0, 600, 800], 1, 0);
  assert.deepEqual(pdfRectToCss([50, 688, 300, 700], vp), { left: 50, top: 100, width: 250, height: 12 });
});

test('clientRectsToPdf drops zero-size rects and normalizes', () => {
  const vp = makeViewport([0, 0, 600, 800], 1, 0);
  const out = clientRectsToPdf([
    { left: 60, top: 100, right: 60, bottom: 112 },
    { left: 50, top: 100, right: 300, bottom: 112 },
  ], { left: 0, top: 0 }, vp);
  assert.deepEqual(out, [[50, 688, 300, 700]]);
});

test('matchRects: selection spanning two sentences gives both ids in order', () => {
  assert.deepEqual(matchRects([[50, 668, 300, 700]], 1, source), ['p1-s1', 'p1-s2']);
});

test('matchRects: sequence order is numeric (s2 before s10)', () => {
  assert.deepEqual(matchRects([[50, 668, 400, 700]], 1, source), ['p1-s1', 'p1-s2', 'p1-s10']);
});

test('matchRects: selection inside a figure matches nothing; bad input is ignored', () => {
  assert.deepEqual(matchRects([[300, 300, 400, 400]], 1, source), []);
  assert.deepEqual(matchRects([], 1, source), []);
  assert.deepEqual(matchRects([[1, 2, 3]], 1, source), []);
  assert.deepEqual(matchRects([[50, 688, 300, 700]], 3, source), []);
});

test('matchSentences delegates with same result', () => {
  const r = matchSentences({ annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[50, 668, 300, 700]] }) }, source);
  assert.deepEqual(r, { page: 1, sentenceIds: ['p1-s1', 'p1-s2'] });
});

test('sentenceAtPoint: inside, boundary, outside, candidates, page', () => {
  assert.equal(sentenceAtPoint(100, 690, 1, source), 'p1-s1');
  assert.equal(sentenceAtPoint(50, 688, 1, source), 'p1-s1', 'edge is inside');
  assert.equal(sentenceAtPoint(300, 700, 1, source), 'p1-s1');
  assert.equal(sentenceAtPoint(300.1, 690, 1, source), null);
  assert.equal(sentenceAtPoint(100, 690, 2, source), 'p2-s1');
  assert.equal(sentenceAtPoint(100, 690, 1, source, ['p1-s2']), null);
  assert.equal(sentenceAtPoint(100, 670, 1, source, ['p1-s2']), 'p1-s2');
  assert.equal(sentenceAtPoint(100, 690, 1, source, new Set(['p1-s1'])), 'p1-s1');
});
