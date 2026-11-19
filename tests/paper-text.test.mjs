import test from 'node:test';
import assert from 'node:assert/strict';
import { paperText, figuresText } from '../src/agent/paper-text.mjs';

const source = {
  id: 'p',
  blocks: [
    { id: 'b1', type: 'heading', page: 1, sentenceIds: ['p1-s1'] },
    { id: 'b2', type: 'paragraph', page: 1, sentenceIds: ['p1-s2', 'p1-s3'] },
    { id: 'b3', type: 'paragraph', page: 2, sentenceIds: ['p2-s1'], inFigure: 'Figure 1' },
    { id: 'b4', type: 'caption', page: 2, sentenceIds: ['p2-s2'] },
    { id: 'b5', type: 'references', page: 2, sentenceIds: ['p2-s3'] },
    { id: 'b6', type: 'paragraph', page: 2, sentenceIds: ['p2-s4'] },
  ],
  sentences: {
    'p1-s1': { text: 'Title', page: 1 },
    'p1-s2': { text: 'Hello\nworld  here.', page: 1 },
    'p1-s3': { text: 'Second.', page: 1 },
    'p2-s1': { text: 'Axis label', page: 2 },
    'p2-s2': { text: 'Figure 1: A figure.', page: 2 },
    'p2-s3': { text: 'REFERENCE ENTRY', page: 2 },
    'p2-s4': { text: 'After.', page: 2 },
  },
  figures: [
    { label: 'Figure 1', page: 2, captionSentenceId: 'p2-s2', bbox: [0, 0, 1, 1] },
    { label: 'Table 1', page: 3, captionSentenceId: 'p3-s9' },
  ],
};

test('paperText format, order, page markers and prefixes', () => {
  assert.equal(paperText(source), [
    '## p.1',
    '### [p1-s1] Title',
    '[p1-s2] Hello world here.',
    '[p1-s3] Second.',
    '## p.2',
    '(figure text) [p2-s1] Axis label',
    '(caption) [p2-s2] Figure 1: A figure.',
    '[p2-s4] After.',
    '',
  ].join('\n'));
});

test('paperText excludes references and tolerates missing sentences', () => {
  assert.doesNotMatch(paperText(source), /REFERENCE/);
  const s = { blocks: [{ id: 'b', type: 'paragraph', page: 1, sentenceIds: ['x'] }], sentences: {} };
  assert.equal(paperText(s), '## p.1\n');
});

test('figuresText one line per figure', () => {
  assert.equal(figuresText(source), 'Figure 1 | p.2 | caption: p2-s2\nTable 1 | p.3 | caption: p3-s9\n');
  assert.equal(figuresText({ figures: [] }), '');
});

test('missing page or caption id is omitted, never printed as undefined', () => {
  const s = { blocks: [{ id: 'b', type: 'paragraph', sentenceIds: ['a'] }], sentences: { a: { text: 'T' } }, figures: [{ label: 'Figure 9' }] };
  assert.equal(paperText(s), '[a] T\n');
  assert.equal(figuresText(s), 'Figure 9\n');
});
