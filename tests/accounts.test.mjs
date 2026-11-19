import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeAliases, claudeProfiles, profileView } from '../src/agent/accounts.mjs';

async function fakeHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-acct-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
const put = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };

test('parseClaudeAliases: single/double quotes, export, ~ and $HOME expansion; other lines ignored', () => {
  const rc = [
    "alias claude-yvin='CLAUDE_CONFIG_DIR=~/.claude/yvin claude'",
    'alias cw="CLAUDE_CONFIG_DIR=$HOME/.claude-work claude --verbose"',
    "  alias c3='export CLAUDE_CONFIG_DIR=\"${HOME}/c 3\" claude'",
    "alias abs='CLAUDE_CONFIG_DIR=/opt/claude-x claude'",
    "# alias commented='CLAUDE_CONFIG_DIR=~/.x claude'",
    "alias notclaude='CLAUDE_CONFIG_DIR=~/.y codex'",
    "alias rel='CLAUDE_CONFIG_DIR=rel/dir claude'",
    "alias envvar='CLAUDE_CONFIG_DIR=$OTHER/x claude'",
    "alias claude='CLAUDE_CONFIG_DIR=~/.z claude'",
    "alias ll='ls -l'",
  ].join('\n');
  assert.deepEqual(parseClaudeAliases(rc, '/h'), [
    { label: 'claude-yvin', dir: '/h/.claude/yvin' },
    { label: 'cw', dir: '/h/.claude-work' },
    { label: 'c3', dir: '/h/c 3' },
    { label: 'abs', dir: '/opt/claude-x' },
  ]);
});

test('claudeProfiles: default first, then aliases from rc files whose dir exists; deduped', async (t) => {
  const home = await fakeHome(t);
  await fs.mkdir(path.join(home, '.claude', 'yvin'), { recursive: true });
  await put(path.join(home, '.zshrc'), "alias claude-yvin='CLAUDE_CONFIG_DIR=~/.claude/yvin claude'\nalias gone='CLAUDE_CONFIG_DIR=~/.nope claude'\nalias same='CLAUDE_CONFIG_DIR=~/.claude claude'\n");
  await put(path.join(home, '.bashrc'), "alias claude-yvin2=\"CLAUDE_CONFIG_DIR=~/.claude/yvin claude\"\n");
  const ps = await claudeProfiles({ home });
  assert.deepEqual(ps.map((p) => [p.label, p.dir]), [['claude', null], ['claude-yvin', path.join(home, '.claude', 'yvin')]]);
  // no rc files at all: just the default
  const bare = await fakeHome(t);
  assert.deepEqual((await claudeProfiles({ home: bare })).map((p) => p.label), ['claude']);
});

test('profileView: email from the account file (that field only), model, lastModel; no paths', async (t) => {
  const home = await fakeHome(t);
  const yvin = path.join(home, '.claude', 'yvin');
  await put(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', accountUuid: 'SECRET' }, projects: { '/secret/path': {} } }));
  await put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
  await put(path.join(yvin, '.claude.json'), JSON.stringify({ projects: {} }));
  await put(path.join(yvin, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
  const lastModels = { 'claude:claude-yvin': { model: 'claude-sonnet-4-5', at: '2026-11-19T00:00:00.000Z' } };
  const d = await profileView({ label: 'claude', dir: null }, { home, env: {}, lastModels });
  assert.deepEqual(d, { label: 'claude', email: 'a@x.com', configuredModel: 'opus', lastModel: null });
  const y = await profileView({ label: 'claude-yvin', dir: yvin }, { home, env: {}, lastModels });
  assert.deepEqual(y, { label: 'claude-yvin', email: '로그인 정보 없음', configuredModel: 'sonnet', lastModel: lastModels['claude:claude-yvin'] });
  assert.doesNotMatch(JSON.stringify([d, y]), /SECRET|secret|\//);
});
