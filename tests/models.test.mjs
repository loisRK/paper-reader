import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuredModel, parseCodexModel, DEFAULT_MODEL_TEXT } from '../src/agent/models.mjs';
import { readSettings, writeSettings, recordLastModel } from '../src/library/settings.mjs';

async function fakeHome(t, files) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true });
    await fs.writeFile(path.join(home, rel), content);
  }
  return home;
}

test('configured model: each tool\'s own config, read-only; missing or garbage -> default text', async (t) => {
  assert.equal(DEFAULT_MODEL_TEXT, '기본값 (계정 플랜에 따라 정해짐)');
  const home = await fakeHome(t, {
    '.claude/settings.json': JSON.stringify({ model: 'opus', apiKeyHelper: 'SECRET', permissions: {} }),
    '.codex/config.toml': '# c\nmodel = "gpt-5-codex"  # note\napi_key = "SECRET"\n[profiles.x]\nmodel = "other"\n',
  });
  const before = await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8');
  assert.equal(await configuredModel('claude', { home, env: {} }), 'opus');
  assert.equal(await configuredModel('claude', { home, env: { ANTHROPIC_MODEL: 'sonnet' } }), 'sonnet');
  assert.equal(await configuredModel('codex', { home, env: {} }), 'gpt-5-codex');
  assert.equal(await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8'), before);

  const empty = await fakeHome(t, {});
  for (const id of ['claude', 'codex']) assert.equal(await configuredModel(id, { home: empty, env: {} }), DEFAULT_MODEL_TEXT, id);
  const garbage = await fakeHome(t, {
    '.claude/settings.json': '{not json',
    '.codex/config.toml': 'model = \n[x]\n',
  });
  for (const id of ['claude', 'codex']) assert.equal(await configuredModel(id, { home: garbage, env: {} }), DEFAULT_MODEL_TEXT, id);
  const legacy = await fakeHome(t, { '.claude/settings.json': JSON.stringify({ model: 'x'.repeat(500) }) });
  assert.equal(await configuredModel('claude', { home: legacy, env: {} }), DEFAULT_MODEL_TEXT); // absurd value is not shown
  // injected readFile: only the tool's own config path is asked for
  const asked = [];
  await configuredModel('codex', { home: '/h', env: {}, readFile: async (p) => { asked.push(p); return "model = 'o3'\n"; } });
  assert.deepEqual(asked, [path.join('/h', '.codex', 'config.toml')]);
});

test('parseCodexModel: top-level key only', () => {
  assert.equal(parseCodexModel('model="a"'), 'a');
  assert.equal(parseCodexModel("model = 'b'"), 'b');
  assert.equal(parseCodexModel('model_provider = "x"\n'), null);
  assert.equal(parseCodexModel('[a]\nmodel = "c"\n'), null);
  assert.equal(parseCodexModel(''), null);
});

test('settings: lastModels recorded per key and kept across other writes', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-lm-'));
  try {
    await recordLastModel(d, 'codex', 'gpt-5-codex', '2026-11-19T01:02:03.000Z');
    await writeSettings(d, { agent: 'codex' });
    await recordLastModel(d, 'claude:claude', 'opus', '2026-11-19T02:00:00.000Z');
    const s = await readSettings(d);
    assert.equal(s.agent, 'codex');
    assert.deepEqual(s.lastModels, {
      codex: { model: 'gpt-5-codex', at: '2026-11-19T01:02:03.000Z' },
      'claude:claude': { model: 'opus', at: '2026-11-19T02:00:00.000Z' },
    });
    await writeSettings(d, { folders: [] });
    assert.equal((await readSettings(d)).lastModels.codex.model, 'gpt-5-codex');
    await fs.writeFile(path.join(d, 'settings.json'), JSON.stringify({ folders: [], lastModels: { codex: { model: 5 }, gemini: 'x', claude: { model: 'm', at: 't' } } }));
    assert.deepEqual((await readSettings(d)).lastModels, { claude: { model: 'm', at: 't' } });
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('settings: concurrent writes are serialized (no lost update)', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-q-'));
  try {
    await Promise.all([
      recordLastModel(d, 'codex', 'm1', 't1'),
      writeSettings(d, { agent: 'claude' }),
      recordLastModel(d, 'claude:x', 'm2', 't2'),
      writeSettings(d, { agentProfile: { claude: 'claude-yvin' } }),
      writeSettings(d, { agent: 'nope' }).catch(() => 'rejected'),
      recordLastModel(d, 'claude:claude', 'm3', 't3'),
    ]);
    const s = await readSettings(d);
    assert.equal(s.agent, 'claude');
    assert.deepEqual(s.agentProfile, { claude: 'claude-yvin' });
    assert.deepEqual(Object.keys(s.lastModels).sort(), ['claude:claude', 'claude:x', 'codex']);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
