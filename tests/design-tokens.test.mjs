import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/reader/public/styles.css', import.meta.url), 'utf8');

function vars(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const lightBlock = css.match(/^:root\s*\{([^}]*)\}/m)[1];
const darkBlock = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)[1];
const light = vars(lightBlock);
const dark = vars(darkBlock);

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('light tokens match the Apple palette', () => {
  assert.equal(light['--text'], '#1d1d1f');
  assert.equal(light['--bg'], '#f5f5f7');
  assert.equal(light['--surface'], '#ffffff');
  assert.equal(light['--accent'], '#0066cc');
  assert.equal(light['--line'], '#e0e0e0');
});

test('dark tokens', () => {
  assert.equal(dark['--bg'], '#000000');
  assert.equal(dark['--surface'], '#1d1d1f');
  assert.equal(dark['--text'], '#f5f5f7');
  assert.equal(dark['--accent'], '#2997ff');
  assert.equal(dark['--on-accent'], '#000000');
});

for (const [name, t] of [['light', light], ['dark', dark]]) {
  test(`contrast AA (${name})`, () => {
    const pairs = [
      ['--text', '--bg', 4.5], ['--text', '--surface', 4.5], ['--muted', '--surface', 4.5],
      ['--accent', '--surface', 4.5], ['--on-accent', '--accent', 4.5], ['--text', '--hl', 4.5],
      ['--accent-strong', '--accent-soft', 4.5],
    ];
    for (const [fg, bg, min] of pairs) {
      assert.ok(contrast(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
    }
  });
}

test('no teal/lime/gradient left', () => {
  assert.doesNotMatch(css, /#0f766e|#115e59|#4d7c0f|#84cc16|#a3e635|#2dd4bf|linear-gradient|--lime/i);
});

test('no shadows on cards and tiles', () => {
  assert.equal(light['--shadow'], 'none');
  assert.equal(dark['--shadow'], 'none');
});

test('buttons use --on-accent text on accent', () => {
  assert.match(css, /\.btn\s*\{[^}]*color:\s*var\(--on-accent\)/);
  assert.match(css, /\.toggle\[aria-pressed="true"\][^{]*\{[^}]*var\(--on-accent\)/);
});
