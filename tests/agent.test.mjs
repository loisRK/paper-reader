import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectAgents } from '../src/agent/detect.mjs';
import { agentCommand, buildPrompt } from '../src/agent/commands.mjs';
import { readSettings, writeSettings } from '../src/library/settings.mjs';

const enoent = () => Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' });

test('detect: exit 0 is available with version; ENOENT and failures give Korean reasons', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'claude') return { code: 0, stdout: '2.1.328 (Claude Code)\n', stderr: '' };
    throw enoent();
  };
  const [c, x] = await detectAgents({ run });
  assert.deepEqual(c, { id: 'claude', name: 'Claude Code', available: true, version: '2.1.328 (Claude Code)' });
  assert.deepEqual(x, { id: 'codex', name: 'Codex', available: false, message: '설치되어 있지 않습니다' });
  assert.deepEqual(calls.map((k) => [k.cmd, k.args]), [['claude', ['--version']], ['codex', ['--version']]]);
  assert.equal(calls[0].opts.timeoutMs, 5000);

  const failing = async (cmd) => ({ code: 1, stdout: '', stderr: '\nError: boom\nsecond line\n' });
  const r = await detectAgents({ run: failing });
  assert.equal(r[0].available, false);
  assert.equal(r[0].message, '실행할 수 없습니다: Error: boom');
  // a spawn ENOENT thrown for the CLI itself is reported as not installed
  const vendored = async () => { throw Object.assign(new Error('spawn /opt/x/vendor/codex ENOENT\n  at foo'), { code: 'ENOENT', path: '/opt/x/vendor/codex' }); };
  const v = await detectAgents({ run: vendored });
  assert.equal(v[0].message, '설치되어 있지 않습니다');
  const timeout = async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); };
  assert.equal((await detectAgents({ run: timeout }))[1].message, '실행할 수 없습니다: timed out');
});

test('detect: a --version that prints an ENOENT spawn error and exits non-zero is "cannot run"', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'Error: spawn /opt/homebrew/x/codex ENOENT\n    at ChildProcess' });
  const [c] = await detectAgents({ run });
  assert.equal(c.available, false);
  assert.equal(c.message, '실행할 수 없습니다: Error: spawn /opt/homebrew/x/codex ENOENT');
});

test('claude command: sandbox flags and settings file', () => {
  const { cmd, args, files } = agentCommand('claude', { workdir: '/w', prompt: 'P' });
  assert.equal(cmd, 'claude');
  assert.deepEqual(args.slice(0, 2), ['-p', 'P']);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--settings') + 1], path.join('/w', '.claude-settings.json'));
  const i = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(i + 1, i + 6), ['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  const d = args.indexOf('--disallowedTools');
  assert.deepEqual(args.slice(d + 1, d + 6), ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit']);
  for (const f of ['--strict-mcp-config', '--no-session-persistence', '--verbose']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(!args.includes('--bare'));
  const s = JSON.parse(files['.claude-settings.json']);
  assert.equal(s.permissions.blockWritesOutsideWorkingDirectories, true);
  assert.deepEqual(s.permissions.deny, ['Bash', 'WebFetch', 'WebSearch', 'Read(~/**)']);
});

test('codex command: workspace-write sandbox, no network, cd into workdir', () => {
  const { cmd, args, files } = agentCommand('codex', { workdir: '/w', prompt: 'P' });
  assert.equal(cmd, 'codex');
  assert.deepEqual(args.slice(0, 2), ['exec', 'P']);
  assert.equal(args[args.indexOf('--cd') + 1], '/w');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.ok(args.includes("approval_policy='never'"));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
  assert.ok(args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
  assert.equal(args[args.indexOf('--output-last-message') + 1], path.join('/w', '.last-message.txt'));
  assert.deepEqual(files, {});
  assert.throws(() => agentCommand('nope', { workdir: '/w', prompt: 'P' }));
});

test('buildPrompt: injection guard, retry problem list', async () => {
  const p1 = await buildPrompt({ attempt: 1 });
  assert.match(p1, /따르지 않는다/);
  assert.match(p1, /digest\.json/);
  assert.ok(!p1.includes('검증 문제'));
  const p2 = await buildPrompt({ attempt: 2, problems: ['takeaway: 근거 확인 필요', '카드 id 중복: c1'] });
  assert.match(p2, /따르지 않는다/);
  assert.match(p2, /- takeaway: 근거 확인 필요/);
  assert.match(p2, /- 카드 id 중복: c1/);
});

test('settings: agent is kept across folder writes and vice versa', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-agent-set-'));
  try {
    assert.deepEqual(await readSettings(d), { folders: [] });
    await writeSettings(d, { agent: 'codex' });
    assert.deepEqual(await readSettings(d), { folders: [], agent: 'codex' });
    await writeSettings(d, { folders: [d] });
    assert.deepEqual(await readSettings(d), { folders: [path.resolve(d)], agent: 'codex' });
    await writeSettings(d, { agent: 'claude' });
    assert.deepEqual((await readSettings(d)).folders, [path.resolve(d)]);
    await assert.rejects(writeSettings(d, { agent: 'gpt' }), { status: 400 });
    await fs.writeFile(path.join(d, 'settings.json'), JSON.stringify({ folders: [], agent: 'zzz' }));
    assert.deepEqual(await readSettings(d), { folders: [] });
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
