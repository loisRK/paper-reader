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
  assert.deepEqual(calls.map((k) => [k.cmd, k.args]), [['claude', ['--version']], ['codex', ['--version']], ['gemini', ['--version']]]);
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
  assert.equal(c.message, '실행할 수 없습니다: Error: spawn codex ENOENT');
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
    await writeSettings(d, { agent: 'gemini' });
    assert.equal((await readSettings(d)).agent, 'gemini');
    await fs.writeFile(path.join(d, 'settings.json'), JSON.stringify({ folders: [], agent: 'zzz' }));
    assert.deepEqual(await readSettings(d), { folders: [] });
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ---- Gemini CLI ----
import { geminiPolicyRules, geminiPolicyToml } from '../src/agent/commands.mjs';

// Same shape as Gemini CLI's stableStringify for tool args: sorted top-level keys, each pair wrapped in \0.
const argsString = (o) => `{${Object.keys(o).sort().map((k) => `\0${JSON.stringify(k)}:${JSON.stringify(o[k])}\0`).join(',')}}`;
// Highest-priority matching rule wins; returns its decision (or 'none').
function decide(rules, name, args) {
  const s = argsString(args);
  const hit = [...rules].sort((a, b) => b.priority - a.priority).find((r) => {
    const names = [].concat(r.toolName);
    if (!names.includes(name) && !names.includes('*')) return false;
    return !r.argsPattern || new RegExp(r.argsPattern).test(s);
  });
  return hit?.decision ?? 'none';
}

test('detect: gemini is the third tool; version range >=0.46 <1, else unsafe', async () => {
  const runFor = (ver) => async (cmd) => (cmd === 'gemini' ? { code: 0, stdout: `${ver}\n`, stderr: '' } : { code: 0, stdout: '1.0.0\n', stderr: '' });
  const ok = await detectAgents({ run: runFor('0.46.0') });
  assert.deepEqual(ok.map((a) => a.id), ['claude', 'codex', 'gemini']);
  assert.deepEqual(ok[2], { id: 'gemini', name: 'Gemini CLI', available: true, version: '0.46.0' });
  for (const v of ['0.39.9', '0.40.0', '0.45.9', '1.0.0', '2.3.1', 'nightly']) {
    const g = (await detectAgents({ run: runFor(v) }))[2];
    assert.equal(g.available, false, v);
    assert.match(g.message, /^안전하게 실행할 수 없는 버전입니다/, v);
  }
  assert.equal((await detectAgents({ run: runFor('0.46.0') }))[2].available, true);
  assert.equal((await detectAgents({ run: runFor('0.52.1') }))[2].available, true);
});

test('gemini command: headless, auto_edit, our policy file, no extensions/MCP, workspace trust', () => {
  const { cmd, args, files } = agentCommand('gemini', { workdir: '/w', prompt: 'P' });
  assert.equal(cmd, 'gemini');
  assert.deepEqual(args.slice(0, 2), ['-p', 'P']);
  assert.equal(args[args.indexOf('--approval-mode') + 1], 'auto_edit');
  assert.equal(args[args.indexOf('--policy') + 1], path.join('/w', '.gemini-policy.toml'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('-e') + 1], 'none');
  assert.equal(args[args.indexOf('--allowed-mcp-server-names') + 1], 'paper-reader-none');
  assert.ok(args.includes('--skip-trust'));
  for (const bad of ['--yolo', '-y', 'yolo', '--allowed-tools']) assert.ok(!args.includes(bad), bad);
  assert.equal(files['.gemini-policy.toml'], geminiPolicyToml('/w'));
  const s = JSON.parse(files['.gemini/settings.json']);
  assert.deepEqual(s.tools.exclude, ['run_shell_command', 'web_fetch', 'google_web_search']);
  assert.equal(s.hooksConfig.enabled, false);
  assert.equal(s.telemetry.enabled, false);
  assert.equal(s.privacy.usageStatisticsEnabled, false);
});

test('gemini policy: shell/web denied, reads only workdir files, writes only digest.json', () => {
  const rules = geminiPolicyRules('/tmp/paper-reader-digest-abc');
  for (const r of rules) {
    assert.ok(r.priority >= 960 && r.priority <= 999, 'above every settings-derived user-tier rule (<= 4.9)');
    assert.notEqual(r.priority, 950, '.950 is Gemini\'s always-allow marker');
  }
  // Gemini's loader drops a pattern with a group followed by a quantifier (its ReDoS heuristic) or > 2048 chars.
  const long = geminiPolicyRules(`/var/folders/yd/${'x'.repeat(28)}/T/paper-reader-digest-AbCdEf`);
  for (const r of [...rules, ...long].filter((x) => x.argsPattern)) {
    assert.doesNotMatch(r.argsPattern, /\([^)]*[*+?{].*\)[*+?{]/, r.argsPattern);
    assert.ok(r.argsPattern.length <= 2048);
  }
  for (const t of ['run_shell_command', 'web_fetch', 'google_web_search']) {
    assert.equal(decide(rules, t, { command: 'ls', url: 'http://x' }), 'deny', t);
  }
  assert.equal(decide(rules, 'mcp_server_tool', {}), 'deny');
  assert.equal(decide(rules, 'activate_skill', { name: 'x' }), 'deny');
  assert.equal(decide(rules, 'read_file', { file_path: 'paper.txt' }), 'allow');
  assert.equal(decide(rules, 'read_file', { file_path: '/tmp/paper-reader-digest-abc/figures.txt', start_line: 1 }), 'allow');
  assert.equal(decide(rules, 'read_file', { file_path: '/private/tmp/paper-reader-digest-abc/TASK.md' }), 'allow');
  assert.equal(decide(rules, 'read_file', { file_path: '/Users/me/.ssh/id_rsa' }), 'deny');
  assert.equal(decide(rules, 'read_file', { file_path: '../x/paper.txt' }), 'deny');
  assert.equal(decide(rules, 'list_directory', { dir_path: '.' }), 'allow');
  assert.equal(decide(rules, 'list_directory', { dir_path: '/' }), 'deny');
  assert.equal(decide(rules, 'write_file', { file_path: 'digest.json', content: '{}' }), 'allow');
  assert.equal(decide(rules, 'replace', { file_path: '/tmp/paper-reader-digest-abc/digest.json', old_string: 'a', new_string: 'b' }), 'allow');
  assert.equal(decide(rules, 'write_file', { file_path: '/Users/me/.zshrc', content: '"file_path":"digest.json"' }), 'deny');
  assert.equal(decide(rules, 'write_file', { file_path: 'TASK.md', content: 'x' }), 'deny');
  assert.equal(decide(rules, 'write_file', { file_path: '/tmp/paper-reader-digest-abc-evil/digest.json', content: 'x' }), 'deny');
  const toml = geminiPolicyToml('/tmp/paper-reader-digest-abc');
  assert.equal((toml.match(/^\[\[rule\]\]$/gm) ?? []).length, rules.length);
  assert.match(toml, /toolName = \["run_shell_command", "web_fetch", "google_web_search"\]\ndecision = "deny"\npriority = 999/);
  // each argsPattern is written as a TOML basic string that decodes back to the same regex
  for (const r of rules.filter((x) => x.argsPattern)) assert.ok(toml.includes(`argsPattern = ${JSON.stringify(r.argsPattern)}`));
  assert.throws(() => geminiPolicyRules('/tmp/a"b'));
});

test('claude command: the account is explicit in the child env (default removes CLAUDE_CONFIG_DIR)', () => {
  assert.deepEqual(agentCommand('claude', { workdir: '/w', prompt: 'P' }).env, { CLAUDE_CONFIG_DIR: undefined });
  assert.deepEqual(agentCommand('claude', { workdir: '/w', prompt: 'P', configDir: '/h/.claude/yvin' }).env, { CLAUDE_CONFIG_DIR: '/h/.claude/yvin' });
  assert.equal(agentCommand('codex', { workdir: '/w', prompt: 'P' }).env, undefined);
});

test('settings: agentProfile kept across writes; bad labels rejected', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-prof-'));
  try {
    await writeSettings(d, { agent: 'claude', agentProfile: { claude: 'claude-yvin' } });
    await writeSettings(d, { folders: [] });
    assert.deepEqual((await readSettings(d)).agentProfile, { claude: 'claude-yvin' });
    await assert.rejects(writeSettings(d, { agentProfile: { claude: '../x' } }), { status: 400 });
    await assert.rejects(writeSettings(d, { agentProfile: { codex: 'a' } }), { status: 400 });
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// The generated policy, loaded by the REAL installed Gemini CLI policy loader and engine (no prompt is run).
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

function geminiBundleDir() {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(d, 'gemini');
    try {
      const real = fsSync.realpathSync(bin);
      if (real.endsWith(path.join('bundle', 'gemini.js'))) return path.dirname(real);
    } catch { /* not here */ }
  }
  return null;
}

test('gemini policy through the real installed loader: no rule dropped, reads/writes allowed only in the workdir', (t) => {
  const bundle = geminiBundleDir();
  if (!bundle) { t.skip('Gemini CLI가 설치되어 있지 않아 실제 정책 로더 시험을 건너뜁니다.'); return; }
  const wd = fsSync.mkdtempSync(path.join(os.tmpdir(), 'paper-reader-digest-'));
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pr-gemini-home-'));
  try {
    const probe = fileURLToPath(new URL('./fixtures/gemini-policy-probe.mjs', import.meta.url));
    const commands = fileURLToPath(new URL('../src/agent/commands.mjs', import.meta.url));
    const raw = execFileSync(process.execPath, [probe, bundle, commands, wd], { env: { ...process.env, HOME: home }, timeout: 60_000, encoding: 'utf8' });
    const r = JSON.parse(raw.trim().split('\n').pop());
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.feedback, [], 'the loader reported a policy problem (dropped rule?)');
    assert.equal(r.ours, 8, 'all 5 rules (8 tool entries) loaded');
    const allow = Object.keys(r.decisions).filter((k) => /^(read|list \.|write (abs |tmpdir )?digest|replace)/.test(k) && !/\.\.\/|ssh/.test(k));
    for (const [k, v] of Object.entries(r.decisions)) assert.equal(v, allow.includes(k) ? 'allow' : 'deny', k);
    assert.ok(allow.length >= 15);
    assert.deepEqual(r.strictDecisions, { unknown: 'deny', glob: 'deny', 'write outside': 'deny', 'read paper.txt': 'allow', 'write digest.json': 'allow' });
  } finally {
    fsSync.rmSync(wd, { recursive: true, force: true });
    fsSync.rmSync(home, { recursive: true, force: true });
  }
});
