import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZOTERO_COLORS, TAG, toZoteroAnnotation, sortIndex, matchSentences, isMine,
} from '../src/zotero/annotations.mjs';

const source = {
  pages: [
    { page: 1, width: 600, height: 800, rotation: 0 },
    { page: 2, width: 600, height: 800, rotation: 0 },
  ],
  sentences: {
    'p1-s1': { text: 'First sentence.', page: 1, block: 0, rects: [[50, 100, 300, 112]], pdfRects: [[50, 688, 300, 700]] },
    'p1-s2': { text: 'Second one.', page: 1, block: 0, rects: [[50, 120, 200, 132]], pdfRects: [[50, 668, 200, 680]] },
    'p1-s3': { text: 'Third.', page: 1, block: 1, rects: [[50, 300, 100, 312]], pdfRects: [[50, 488, 100, 500]] },
    'p2-s1': { text: 'Other page.', page: 2, block: 0, rects: [[50, 100, 300, 112]], pdfRects: [[50, 688, 300, 700]] },
    'p1-old': { text: 'old', page: 1, block: 0, rects: [[0, 0, 1, 1]] },
  },
};

test('constants', () => {
  assert.equal(TAG, 'paper-reader');
  assert.equal(ZOTERO_COLORS.yellow, '#ffd400');
});

test('toZoteroAnnotation builds highlight with pageIndex, joined text, tag', () => {
  const a = toZoteroAnnotation({ sentenceIds: ['p1-s2', 'p1-s3'], comment: 'hi' }, source, 'ATT1');
  assert.equal(a.itemType, 'annotation');
  assert.equal(a.parentItem, 'ATT1');
  assert.equal(a.annotationType, 'highlight');
  assert.equal(a.annotationText, 'Second one. Third.');
  assert.equal(a.annotationComment, 'hi');
  assert.equal(a.annotationColor, '#ffd400');
  assert.equal(a.annotationPageLabel, '1');
  assert.deepEqual(JSON.parse(a.annotationPosition), {
    pageIndex: 0, rects: [[50, 668, 200, 680], [50, 488, 100, 500]],
  });
  assert.deepEqual(a.tags, [{ tag: 'paper-reader' }]);
  // charOffset = len('First sentence.')=15 ; top = floor(min y0 = 120)
  assert.equal(a.annotationSortIndex, '00000|000015|00120');
});

test('toZoteroAnnotation defaults comment and honors color', () => {
  const a = toZoteroAnnotation({ sentenceIds: ['p1-s1'], color: '#ff6666' }, source, 'A');
  assert.equal(a.annotationComment, '');
  assert.equal(a.annotationColor, '#ff6666');
  assert.equal(a.annotationSortIndex, '00000|000000|00100');
});

test('sortIndex pads to 00000|000123|00045', () => {
  assert.equal(sortIndex(0, 123, 45), '00000|000123|00045');
});

test('sentences on two pages → throws one-page error', () => {
  assert.throws(
    () => toZoteroAnnotation({ sentenceIds: ['p1-s1', 'p2-s1'] }, source, 'A'),
    { message: '한 하이라이트는 한 페이지 안의 문장만 담을 수 있습니다.' },
  );
});

test('missing pdfRects → throws NEEDS_REEXTRACT', () => {
  assert.throws(
    () => toZoteroAnnotation({ sentenceIds: ['p1-s1', 'p1-old'] }, source, 'A'),
    { message: 'NEEDS_REEXTRACT' },
  );
});

const pos = (o) => ({ annotationPosition: JSON.stringify(o) });

test('matchSentences returns overlapping sentence ids in order', () => {
  const r = matchSentences(pos({ pageIndex: 0, rects: [[50, 688, 300, 700], [50, 668, 200, 680]] }), source);
  assert.deepEqual(r, { page: 1, sentenceIds: ['p1-s1', 'p1-s2'] });
});

test('matchSentences: 30% threshold', () => {
  // annotation area 100x10=1000; overlap with s1 (y 688-700): y688-698 =10 → 100%... use narrow
  const lo = matchSentences(pos({ pageIndex: 0, rects: [[50, 688, 350, 700]] }), source); // 250/300 overlap
  assert.deepEqual(lo.sentenceIds, ['p1-s1']);
  const miss = matchSentences(pos({ pageIndex: 0, rects: [[280, 688, 580, 700]] }), source); // 20/300 < 30%
  assert.deepEqual(miss.sentenceIds, []);
});

test('matchSentences: one line-wide rect over three short sentences → all three matched', () => {
  const line = {
    sentences: {
      'p1-s1': { text: 'A.', page: 1, pdfRects: [[50, 688, 150, 700]] },
      'p1-s2': { text: 'B.', page: 1, pdfRects: [[160, 688, 300, 700]] },
      'p1-s3': { text: 'C.', page: 1, pdfRects: [[310, 688, 450, 700]] },
      'p1-s4': { text: 'Next line.', page: 1, pdfRects: [[50, 668, 550, 680]] },
    },
  };
  // each sentence covers < 30% of the 500-wide annotation rect, but the rect covers 100% of each sentence
  const r = matchSentences(pos({ pageIndex: 0, rects: [[50, 688, 550, 700]] }), line);
  assert.deepEqual(r.sentenceIds, ['p1-s1', 'p1-s2', 'p1-s3']);
  // a sentence only 20% covered by a much larger rect is still not matched
  const part = matchSentences(pos({ pageIndex: 0, rects: [[400, 688, 1400, 700]] }), line);
  assert.deepEqual(part.sentenceIds, []);
});

test('matchSentences: no overlap or note annotation → empty ids with page', () => {
  assert.deepEqual(matchSentences(pos({ pageIndex: 1, rects: [[0, 0, 10, 10]] }), source), { page: 2, sentenceIds: [] });
  assert.deepEqual(matchSentences(pos({ pageIndex: 0, paths: [[1, 2, 3, 4]] }), source), { page: 1, sentenceIds: [] });
  assert.deepEqual(matchSentences({ annotationPosition: 'not json' }, source).sentenceIds, []);
  assert.deepEqual(matchSentences({}, source).sentenceIds, []);
});

test('isMine true only with paper-reader tag', () => {
  assert.equal(isMine({ tags: [{ tag: 'paper-reader' }] }), true);
  assert.equal(isMine({ data: { tags: [{ tag: 'paper-reader' }] } }), true);
  assert.equal(isMine({ tags: [{ tag: 'x' }] }), false);
  assert.equal(isMine({}), false);
});
