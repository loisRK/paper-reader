import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, VENV_INSTALL_COMMAND } from '../src/digest/extract-cli.mjs';

const resolved = {
  id: 'kim2025reader',
  itemKey: 'H9RA4VSE',
  attachmentKey: 'IG8JQQUI',
  pdfPath: '/Users/x/Zotero/storage/IG8JQQUI/논문 파일.pdf',
  meta: { title: 'A Reader Paper', authors: ['Kim A'], journal: 'J', date: '2025', doi: '10.1/x' },
};
const extracted = {
  extractorVersion: 1,
  pymupdfVersion: '2.1',
  pages: [{ page: 1, width: 612, height: 792 }, { page: 2, width: 612, height: 792 }],
  blocks: [{ id: 'b1', type: 'caption', page: 1, sentenceIds: ['p1-s1', 'p1-s2'] }],
  sentences: {
    'p1-s1': { text: 'Figure 1. A.', page: 1, block: 'b1', rects: [] },
    'p1-s2': { text: 'More.', page: 1, block: 'b1', rects: [] },
  },
  figures: [{ label: 'Figure 1', page: 1, captionSentenceId: 'p1-s1' }],
};

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-cli-'));
  const python = path.join(dir, 'python');
  await fs.writeFile(python, '');
  const logs = [];
  const errors = [];
  return {
    dir,
    logs,
    errors,
    opts: {
      cfg: { outputDir: path.join(dir, 'out') },
      pythonPath: python,
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    },
  };
}

test('merges id, zotero keys and meta into <outputDir>/<id>/source.json', async () => {
  const { dir, logs, opts } = await setup();
  const calls = [];
  const code = await main(['H9RA4VSE'], {
    ...opts,
    resolveItem: async (idOrKey, cfg) => (calls.push({ idOrKey, cfg }), resolved),
    runPython: async (python, args) => {
      calls.push({ python, args });
      await fs.writeFile(args[2], JSON.stringify(extracted));
      return { code: 0, stderr: '' };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls[0].idOrKey, 'H9RA4VSE');
  assert.equal(calls[1].python, opts.pythonPath);
  assert.match(calls[1].args[0], /extract[/\\]extract_pdf\.py$/);
  assert.equal(calls[1].args[1], resolved.pdfPath);

  const saved = JSON.parse(await fs.readFile(path.join(dir, 'out', 'kim2025reader', 'source.json'), 'utf8'));
  assert.equal(saved.id, 'kim2025reader');
  assert.deepEqual(saved.zotero, { itemKey: 'H9RA4VSE', attachmentKey: 'IG8JQQUI' });
  assert.equal(saved.meta.title, 'A Reader Paper');
  assert.deepEqual(Object.keys(saved), ['extractorVersion', 'pymupdfVersion', 'id', 'zotero', 'meta', 'pages', 'blocks', 'sentences', 'figures']);
  assert.deepEqual(saved.sentences, extracted.sentences);

  const out = logs.join('\n');
  assert.match(out, /문장 2개/);
  assert.match(out, /페이지 2쪽/);
  assert.match(out, /그림·표 1개 \(이미지 0개\)/);
  assert.ok(out.includes("이제 AI 도구에게 'prompts/digest.md 규칙으로 kim2025reader 요약을 써줘'라고 요청하세요."));
  await assert.rejects(fs.access(calls[1].args[2]), 'temp file is cleaned up');
});

test('passes --figures-dir <outputDir>/<id>/figures to the extractor and creates it', async () => {
  const { dir, opts } = await setup();
  let seen;
  const code = await main(['H9RA4VSE'], {
    ...opts,
    resolveItem: async () => resolved,
    runPython: async (_py, args) => {
      seen = args;
      const stat = await fs.stat(args[4]);
      assert.ok(stat.isDirectory(), 'figures dir exists before the extractor runs');
      await fs.writeFile(args[2], JSON.stringify(extracted));
      return { code: 0, stderr: '' };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 5);
  assert.equal(seen[3], '--figures-dir');
  assert.equal(seen[4], path.join(dir, 'out', 'kim2025reader', 'figures'));
});

test('missing .venv prints install command and exits 1', async () => {
  const { dir, errors, opts } = await setup();
  let resolvedCalled = false;
  const code = await main(['H9RA4VSE'], {
    ...opts,
    pythonPath: path.join(dir, 'no-venv', 'bin', 'python'),
    resolveItem: async () => { resolvedCalled = true; return resolved; },
    runPython: async () => assert.fail('must not run python'),
  });
  assert.equal(code, 1);
  assert.equal(resolvedCalled, false);
  assert.ok(errors.join('\n').includes(VENV_INSTALL_COMMAND));
  assert.equal(VENV_INSTALL_COMMAND, 'python3 -m venv .venv && .venv/bin/pip install -r extract/requirements.txt');
});

test('python exit 2 prints its stderr and exits 1 without writing', async () => {
  const { dir, errors, opts } = await setup();
  const msg = '텍스트를 추출할 수 없습니다(스캔 PDF로 보입니다). OCR된 PDF로 바꿔주세요.';
  const code = await main(['H9RA4VSE'], {
    ...opts,
    resolveItem: async () => resolved,
    runPython: async () => ({ code: 2, stderr: `${msg}\n` }),
  });
  assert.equal(code, 1);
  assert.ok(errors.join('\n').includes(msg));
  await assert.rejects(fs.access(path.join(dir, 'out', 'kim2025reader', 'source.json')));
});

test('resolveItem failure and missing argument exit 1', async () => {
  const { errors, opts } = await setup();
  const code = await main(['NOPE'], {
    ...opts,
    resolveItem: async () => { throw new Error("Zotero에서 'NOPE' 항목을 찾지 못했습니다."); },
    runPython: async () => assert.fail('must not run python'),
  });
  assert.equal(code, 1);
  assert.ok(errors.join('\n').includes("'NOPE' 항목을 찾지 못했습니다"));
  assert.equal(await main([], opts), 1);
  assert.match(errors.at(-1), /사용법: npm run extract -- <citekey\|itemKey>/);
});

test('broken JSON output or unwritable outputDir prints a one-line error and exits 1', async () => {
  const { dir, errors, opts } = await setup();
  const broken = await main(['H9RA4VSE'], {
    ...opts,
    resolveItem: async () => resolved,
    runPython: async (_py, args) => { await fs.writeFile(args[2], '{not json'); return { code: 0, stderr: '' }; },
  });
  assert.equal(broken, 1);
  assert.match(errors.at(-1), /^추출 결과를 저장하지 못했습니다: /);
  assert.equal(errors.at(-1).includes('\n'), false);

  const blocker = path.join(dir, 'blocker');
  await fs.writeFile(blocker, '');
  const unwritable = await main(['H9RA4VSE'], {
    ...opts,
    cfg: { outputDir: blocker },
    resolveItem: async () => resolved,
    runPython: async (_py, args) => { await fs.writeFile(args[2], JSON.stringify(extracted)); return { code: 0, stderr: '' }; },
  });
  assert.equal(unwritable, 1);
  assert.match(errors.at(-1), /^추출 결과를 저장하지 못했습니다: /);
});

test('rejects an item id that cannot be a folder name before running python', async () => {
  const { dir, errors, opts } = await setup();
  for (const id of ['../x', '..', 'a/b']) {
    const code = await main(['K'], {
      ...opts,
      resolveItem: async () => ({ ...resolved, id }),
      runPython: async () => assert.fail('must not run python'),
    });
    assert.equal(code, 1);
    assert.equal(errors.at(-1), `이 항목 ID(${id})는 폴더 이름으로 쓸 수 없습니다. Zotero 항목 key로 다시 실행하세요.`);
  }
  await assert.rejects(fs.access(path.join(dir, 'x')));
});

test('unreadable config gives the settings wording, not the save wording', async () => {
  const { dir, errors, opts } = await setup();
  const configPath = path.join(dir, 'paper-reader.config.json');
  await fs.writeFile(configPath, '{ broken');
  const { cfg, ...rest } = opts;
  const code = await main(['K'], { ...rest, configPath, resolveItem: async () => assert.fail('no resolve') });
  assert.equal(code, 1);
  assert.match(errors.at(-1), /^설정 파일을 읽지 못했습니다: /);
});

test('exit 0 with stderr prints it as warnings and counts figure images', async () => {
  const { opts, logs, errors } = await setup();
  const withImage = { ...extracted, figures: [{ ...extracted.figures[0], image: 'figures/fig-1-1.png' }] };
  const code = await main(['H9RA4VSE'], {
    ...opts,
    resolveItem: async () => resolved,
    runPython: async (_py, args) => { await fs.writeFile(args[2], JSON.stringify(withImage)); return { code: 0, stderr: '2쪽 그림 영역을 찾지 못했습니다: x\n' }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, ['경고: 2쪽 그림 영역을 찾지 못했습니다: x']);
  assert.match(logs.join('\n'), /그림·표 1개 \(이미지 1개\)/);
});

// ---- extractFile (folder PDF, no Zotero) ----
import { extractFile } from '../src/digest/extract-cli.mjs';

const pyMeta = { title: 'PDF Title', authors: ['Kim A'], date: '2024-03-15', doi: '10.1/pdf', journal: '' };
const pyExtracted = { ...extracted, pdf: { path: '/papers/한글 논문.pdf', md5: 'abc' }, meta: pyMeta };

function filePython(calls = []) {
  return async (python, args) => {
    calls.push({ python, args });
    await fs.writeFile(args[2], JSON.stringify(pyExtracted));
    return { code: 0, stderr: '' };
  };
}

test('extractFile saves source.json with Python meta and no zotero', async () => {
  const { dir, opts } = await setup();
  const calls = [];
  const res = await extractFile({ cfg: opts.cfg, file: '/papers/한글 논문.pdf', id: 'paper-1a2b3c4d', pythonPath: opts.pythonPath, runPython: filePython(calls) });
  assert.equal(res.id, 'paper-1a2b3c4d');
  assert.equal(calls[0].args[1], '/papers/한글 논문.pdf');
  assert.equal(calls[0].args[4], path.join(dir, 'out', 'paper-1a2b3c4d', 'figures'));
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'out', 'paper-1a2b3c4d', 'source.json'), 'utf8'));
  assert.deepEqual(saved, res.source);
  assert.equal(saved.id, 'paper-1a2b3c4d');
  assert.equal(saved.pdf.path, '/papers/한글 논문.pdf');
  assert.deepEqual(saved.meta, pyMeta);
  assert.equal('zotero' in saved, false);
});

test('extractFile with zoteroLink records keys and lets Zotero meta win', async () => {
  const { dir, opts } = await setup();
  const zoteroLink = { itemKey: 'H9RA4VSE', attachmentKey: 'IG8JQQUI', meta: resolved.meta };
  const { source } = await extractFile({ cfg: opts.cfg, file: '/p.pdf', id: 'x1', zoteroLink, pythonPath: opts.pythonPath, runPython: filePython() });
  assert.deepEqual(source.zotero, { itemKey: 'H9RA4VSE', attachmentKey: 'IG8JQQUI' });
  assert.equal(source.meta.title, 'A Reader Paper');
  const noMeta = await extractFile({ cfg: opts.cfg, file: '/p.pdf', id: 'x2', zoteroLink: { itemKey: 'K', attachmentKey: 'A' }, pythonPath: opts.pythonPath, runPython: filePython() });
  assert.equal(noMeta.source.meta.title, 'PDF Title');
  assert.ok(dir);
});

test('extractFile rejects unsafe id, missing venv and python failure with Korean messages', async () => {
  const { dir, opts } = await setup();
  const base = { cfg: opts.cfg, file: '/p.pdf', pythonPath: opts.pythonPath, runPython: filePython() };
  await assert.rejects(extractFile({ ...base, id: '../evil' }), /폴더 이름으로 쓸 수 없습니다/);
  await assert.rejects(extractFile({ ...base, id: 'ok', pythonPath: path.join(dir, 'nope') }), (e) => e.message.includes(VENV_INSTALL_COMMAND));
  await assert.rejects(extractFile({ ...base, id: 'ok', runPython: async () => ({ code: 2, stderr: '스캔 PDF입니다\n' }) }), /^Error: 스캔 PDF입니다$/);
  await assert.rejects(fs.access(path.join(dir, 'out', 'ok', 'source.json')));
});
