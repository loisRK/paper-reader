import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareWorkdir, cleanupWorkdir, runAgent, summarizeStreamLine } from '../src/agent/run.mjs';

function fakeSpawn() {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.pid = 4242;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = (sig) => { c.killed = sig; };
    calls.push({ cmd, args, opts, child: c });
    return c;
  };
  return { impl, calls };
}
const W = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pr-w-'));
const tick = () => new Promise((r) => setImmediate(r));

async function scratch() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-test-'));
  await fs.writeFile(path.join(d, 'source.json'), JSON.stringify({
    id: 'p',
    pages: [{}, {}, {}],
    blocks: [{ id: 'b1', type: 'paragraph', page: 1, sentenceIds: ['p1-s1'] }],
    sentences: { 'p1-s1': { text: 'Body.', page: 1 } },
    figures: [{ label: 'Figure 1', page: 1, captionSentenceId: 'p1-s1' }],
  }));
  await fs.writeFile(path.join(d, 'digest.md'), 'rules');
  await fs.writeFile(path.join(d, 'ctx.md'), 'ctx');
  await fs.writeFile(path.join(d, 'prev.json'), '{"old":1}');
  return d;
}

test('prepareWorkdir creates exactly the allowed files; cleanup removes them', async () => {
  const d = await scratch();
  const w = await prepareWorkdir({ source: path.join(d, 'source.json'), digestRules: path.join(d, 'digest.md') });
  assert.ok(path.basename(w).startsWith('paper-reader-digest-'));
  assert.ok(path.relative(os.homedir(), w).startsWith('..'));
  assert.deepEqual((await fs.readdir(w)).sort(), ['TASK.md', 'digest.md', 'figures.txt', 'paper.txt']);
  assert.equal(await fs.readFile(path.join(w, 'paper.txt'), 'utf8'), '## p.1\n[p1-s1] Body.\n');
  assert.equal(await fs.readFile(path.join(w, 'figures.txt'), 'utf8'), 'Figure 1 | p.1 | caption: p1-s1\n');
  assert.equal((await fs.stat(path.join(w, 'paper.txt'))).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(path.join(w, 'TASK.md'), 'utf8'), /source\.json/);
  assert.match(await fs.readFile(path.join(w, 'TASK.md'), 'utf8'), /논문 ID: `p`/);
  assert.match(await fs.readFile(path.join(w, 'TASK.md'), 'utf8'), /쪽 수: 3/);
  await cleanupWorkdir(w);
  await assert.rejects(fs.stat(w));

  const w2 = await prepareWorkdir({
    source: path.join(d, 'source.json'), digestRules: path.join(d, 'digest.md'),
    researchContext: path.join(d, 'ctx.md'), previousDigest: path.join(d, 'prev.json'),
  });
  // The research-context feature is gone: a stray option copies nothing.
  assert.deepEqual((await fs.readdir(w2)).sort(), ['TASK.md', 'digest.json', 'digest.md', 'figures.txt', 'paper.txt']);
  assert.doesNotMatch(await fs.readFile(path.join(w2, 'TASK.md'), 'utf8'), /research-context/);
  await cleanupWorkdir(w2);
  await cleanupWorkdir(w2); // idempotent
  await fs.rm(d, { recursive: true });
});

test('prepareWorkdir fails loudly when the temp dir is inside the home directory', async () => {
  const d = await scratch();
  const tmp = process.env.TMPDIR;
  const home = os.homedir();
  const under = await fs.mkdtemp(path.join(home, '.pr-test-tmp-'));
  try {
    process.env.TMPDIR = under;
    await assert.rejects(
      prepareWorkdir({ source: path.join(d, 'source.json'), digestRules: path.join(d, 'digest.md') }),
      /홈 폴더/,
    );
    assert.deepEqual(await fs.readdir(under), []); // nothing left behind
  } finally {
    if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp;
    await fs.rm(under, { recursive: true, force: true });
    await fs.rm(d, { recursive: true });
  }
});

test('summarizeStreamLine', () => {
  const line = (o) => JSON.stringify(o);
  const tool = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  assert.equal(summarizeStreamLine(tool('Write', { file_path: '/a/b/digest.json', content: 'SECRET' })), '파일 쓰기: digest.json');
  assert.equal(summarizeStreamLine(tool('Edit', { file_path: '/a/digest.json' })), '파일 쓰기: digest.json');
  assert.equal(summarizeStreamLine(tool('Read', { file_path: '/a/source.json' })), '읽기: source.json');
  assert.equal(summarizeStreamLine(tool('Glob', { pattern: '*' })), null);
  assert.equal(summarizeStreamLine(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(300) }] } })).length, 120);
  assert.equal(summarizeStreamLine(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })), '완료');
  assert.equal(summarizeStreamLine(line({ type: 'result', is_error: true, result: 'Bad thing\nmore' })), '오류: Bad thing');
  assert.equal(summarizeStreamLine(line({ type: 'system', subtype: 'init' })), null);
  assert.equal(summarizeStreamLine(line({ type: 'user', message: { content: [] } })), null);
  assert.equal(summarizeStreamLine('not json'), null);
  assert.equal(summarizeStreamLine(''), null);
});

test('runAgent: line-wise logs, claude stream-json summarized, spawn options', async () => {
  const { impl, calls } = fakeSpawn();
  const logs = [];
  const { done } = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog: (l) => logs.push(l) });
  const { cmd, args, opts, child } = calls[0];
  assert.equal(cmd, 'claude');
  assert.equal(args[0], '-p');
  assert.equal(opts.cwd, W);
  assert.equal(opts.detached, true);
  child.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/w/digest.json","content":"BIG"}}]}}\n{"type":"sys');
  child.stdout.write('tem"}\n{"type":"result","is_error":false}\n');
  child.stderr.write('warn line\n');
  child.stdout.end(); child.stderr.end();
  await tick();
  child.emit('close', 0, null);
  const r = await done;
  assert.deepEqual(logs, ['파일 쓰기: digest.json', '완료', 'warn line']);
  assert.deepEqual(r, { code: 0, signal: null, timedOut: false });
});

test('runAgent: codex output lines are logged raw and truncated to 200 chars', async () => {
  const { impl, calls } = fakeSpawn();
  const logs = [];
  const { done } = runAgent({ id: 'codex', workdir: W, prompt: 'P', spawnImpl: impl, onLog: (l) => logs.push(l) });
  calls[0].child.stdout.write(`hello\n${'y'.repeat(500)}\npartial`);
  calls[0].child.stdout.end(); calls[0].child.stderr.end();
  await tick();
  calls[0].child.emit('close', 0, null);
  await done;
  assert.equal(logs[0], 'hello');
  assert.equal(logs[1].length, 200);
  assert.equal(logs[2], 'partial');
});

test('runAgent: timeout kills the process group and reports timedOut', async () => {
  const { impl, calls } = fakeSpawn();
  const kills = [];
  const { done } = runAgent({ id: 'claude', workdir: W, prompt: 'P', timeoutMs: 20, spawnImpl: impl, onLog() {}, killImpl: (pid, sig) => kills.push([pid, sig]) });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(kills[0], [-4242, 'SIGTERM']);
  calls[0].child.emit('close', null, 'SIGTERM');
  const r = await done;
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGTERM');
});

test('runAgent: cancel kills the group once; done resolves with cancelled-ish signal', async () => {
  const { impl, calls } = fakeSpawn();
  const kills = [];
  const h = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {}, killImpl: (pid, sig) => kills.push([pid, sig]) });
  h.cancel(); h.cancel();
  assert.deepEqual(kills, [[-4242, 'SIGTERM']]);
  calls[0].child.emit('close', null, 'SIGTERM');
  const r = await h.done;
  assert.equal(r.timedOut, false);
  assert.equal(r.signal, 'SIGTERM');
  h.cancel(); // after exit: no further kill
  assert.equal(kills.length, 1);
});

test('runAgent: errorHint for login and usage-limit output', async () => {
  for (const [text, hint] of [
    ['Invalid API key · Please run /login', 'AI 도구 로그인이 필요합니다. 터미널에서 claude를 한 번 실행해 로그인하세요.'],
    ['Error: not logged in', 'AI 도구 로그인이 필요합니다. 터미널에서 codex를 한 번 실행해 로그인하세요.'],
    ['Claude AI usage limit reached|1700000000', 'AI 도구 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.'],
    ['429 rate limit exceeded', 'AI 도구 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.'],
  ]) {
    const id = hint.includes('codex') ? 'codex' : 'claude';
    const { impl, calls } = fakeSpawn();
    const { done } = runAgent({ id, workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
    calls[0].child.stderr.write(`${text}\n`);
    calls[0].child.stdout.end(); calls[0].child.stderr.end();
    await tick();
    calls[0].child.emit('close', 1, null);
    assert.equal((await done).errorHint, hint, text);
  }
  const { impl, calls } = fakeSpawn();
  const { done } = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
  calls[0].child.stderr.write('some other failure\n');
  calls[0].child.stdout.end(); calls[0].child.stderr.end();
  await tick();
  calls[0].child.emit('close', 1, null);
  assert.equal((await done).errorHint, undefined);
});

test('runAgent: spawn error resolves done with a Korean hint', async () => {
  const { impl, calls } = fakeSpawn();
  const { done } = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
  calls[0].child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  const r = await done;
  assert.equal(r.code, null);
  assert.equal(r.errorHint, 'AI 도구를 실행할 수 없습니다. 설치되어 있는지 확인하세요.');
});

test('runAgent: SIGKILL escalation, and done resolves even if close never fires', async () => {
  const { impl, calls } = fakeSpawn();
  const kills = [];
  const h = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {}, graceMs: 20, closeWaitMs: 20, killImpl: (pid, sig) => kills.push([pid, sig]) });
  let destroyed = 0;
  calls[0].child.stdout.destroy = () => { destroyed++; };
  h.cancel();
  const r = await h.done; // no close event is ever emitted
  assert.deepEqual(kills, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(destroyed, 1);
});

test('runAgent: timeout with unresponsive process still resolves with timedOut', async () => {
  const { impl } = fakeSpawn();
  const { done } = runAgent({ id: 'claude', workdir: W, prompt: 'P', timeoutMs: 10, graceMs: 10, closeWaitMs: 10, spawnImpl: impl, onLog() {}, killImpl() {} });
  assert.equal((await done).timedOut, true);
});

test('runAgent: close after SIGTERM cancels the SIGKILL timer', async () => {
  const { impl, calls } = fakeSpawn();
  const kills = [];
  const h = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {}, graceMs: 20, closeWaitMs: 20, killImpl: (p, s) => kills.push(s) });
  h.cancel();
  calls[0].child.emit('close', null, 'SIGTERM');
  await h.done;
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(kills, ['SIGTERM']);
});

test('runAgent: synchronous spawn throw resolves done with an error', async () => {
  const h = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: () => { throw new Error('EACCES'); }, onLog() {} });
  const r = await h.done;
  assert.equal(r.code, null);
  assert.equal(r.errorHint, 'AI 도구를 실행할 수 없습니다. 설치되어 있는지 확인하세요.');
  h.cancel();
});

test('runAgent: stream error events do not crash', async () => {
  const { impl, calls } = fakeSpawn();
  const { done } = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
  calls[0].child.stdout.emit('error', new Error('EPIPE'));
  calls[0].child.stderr.emit('error', new Error('EPIPE'));
  calls[0].child.emit('close', 0, null);
  assert.equal((await done).code, 0);
});

test('runAgent: paper text in stream-json does not trigger a login/limit hint', async () => {
  const { impl, calls } = fakeSpawn();
  const { done } = runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
  calls[0].child.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Authentication is hard; rate limit; please run /login 429' }] } }) + '\n');
  calls[0].child.stdout.end(); calls[0].child.stderr.end();
  await tick();
  calls[0].child.emit('close', 1, null);
  assert.equal((await done).errorHint, undefined);
});

// ---- Gemini CLI ----
import { summarizeGeminiLine } from '../src/agent/run.mjs';

test('summarizeGeminiLine: tool names to short Korean lines, never contents', () => {
  const j = (o) => JSON.stringify(o);
  assert.equal(summarizeGeminiLine(j({ type: 'init', session_id: 's', model: 'gemini-2.5-pro' })), null);
  assert.equal(summarizeGeminiLine(j({ type: 'tool_use', tool_name: 'read_file', tool_id: 't', parameters: { file_path: '/w/paper.txt' } })), '읽기: paper.txt');
  assert.equal(summarizeGeminiLine(j({ type: 'tool_use', tool_name: 'write_file', parameters: { file_path: 'digest.json', content: 'SECRET' } })), '파일 쓰기: digest.json');
  assert.equal(summarizeGeminiLine(j({ type: 'tool_use', tool_name: 'replace', parameters: { file_path: '/w/digest.json', old_string: 'SECRET' } })), '파일 쓰기: digest.json');
  assert.equal(summarizeGeminiLine(j({ type: 'tool_use', tool_name: 'list_directory', parameters: { dir_path: '.' } })), '폴더 보기');
  assert.equal(summarizeGeminiLine(j({ type: 'tool_use', tool_name: 'run_shell_command', parameters: { command: 'rm -rf /' } })), '도구 요청: run_shell_command');
  assert.equal(summarizeGeminiLine(j({ type: 'tool_result', tool_id: 't', status: 'success', output: 'SECRET' })), null);
  assert.equal(summarizeGeminiLine(j({ type: 'tool_result', status: 'error', error: { type: 'x', message: 'Tool denied by policy\nmore' } })), '도구 거부·오류: Tool denied by policy');
  assert.equal(summarizeGeminiLine(j({ type: 'message', role: 'assistant', content: 'SECRET', delta: true })), null);
  assert.equal(summarizeGeminiLine(j({ type: 'result', status: 'success', stats: {} })), '완료');
  assert.equal(summarizeGeminiLine(j({ type: 'result', status: 'error', error: { type: 'API', message: 'Quota exceeded\nx' } })), '오류: Quota exceeded');
  assert.equal(summarizeGeminiLine(j({ type: 'error', severity: 'error', message: 'Maximum session turns exceeded' })), '오류: Maximum session turns exceeded');
  assert.equal(summarizeGeminiLine(j({ type: 'error', severity: 'warning', message: 'Loop detected' })), '경고: Loop detected');
  assert.equal(summarizeGeminiLine('Loaded cached credentials.'), null);
});

test('runAgent gemini: policy + settings files written into the workdir, stream-json summarized', async () => {
  const w = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-gw-'));
  const { impl, calls } = fakeSpawn();
  const logs = [];
  const { done } = runAgent({ id: 'gemini', workdir: w, prompt: 'P', spawnImpl: impl, onLog: (l) => logs.push(l) });
  assert.equal(calls[0].cmd, 'gemini');
  assert.match(await fs.readFile(path.join(w, '.gemini-policy.toml'), 'utf8'), /run_shell_command/);
  assert.ok(JSON.parse(await fs.readFile(path.join(w, '.gemini', 'settings.json'), 'utf8')).tools);
  calls[0].child.stdout.write('{"type":"init","model":"gemini-2.5-pro"}\n{"type":"tool_use","tool_name":"write_file","parameters":{"file_path":"digest.json","content":"BIG"}}\n{"type":"result","status":"success"}\n');
  calls[0].child.stdout.end(); calls[0].child.stderr.end();
  await tick();
  calls[0].child.emit('close', 0, null);
  await done;
  assert.deepEqual(logs, ['파일 쓰기: digest.json', '완료']);
  await fs.rm(w, { recursive: true });
});

test('runAgent gemini: login and quota hints', async () => {
  for (const [text, hint] of [
    ['Please set an Auth method in your settings.json or specify GEMINI_API_KEY', 'AI 도구 로그인이 필요합니다. 터미널에서 gemini를 한 번 실행해 로그인하세요.'],
    ['When using Gemini API, you must specify the GEMINI_API_KEY environment variable.', 'AI 도구 로그인이 필요합니다. 터미널에서 gemini를 한 번 실행해 로그인하세요.'],
    ['[API Error: RESOURCE_EXHAUSTED]', 'AI 도구 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.'],
    ['Quota exceeded for quota metric', 'AI 도구 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.'],
  ]) {
    const { impl, calls } = fakeSpawn();
    const { done } = runAgent({ id: 'gemini', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
    calls[0].child.stderr.write(`${text}\n`);
    calls[0].child.stdout.end(); calls[0].child.stderr.end();
    await tick();
    calls[0].child.emit('close', 1, null);
    assert.equal((await done).errorHint, hint, text);
  }
  // a stream-json result error also feeds the hint
  const { impl, calls } = fakeSpawn();
  const { done } = runAgent({ id: 'gemini', workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
  calls[0].child.stdout.write('{"type":"result","status":"error","error":{"message":"Quota exceeded"}}\n');
  calls[0].child.stdout.end(); calls[0].child.stderr.end();
  await tick();
  calls[0].child.emit('close', 1, null);
  assert.equal((await done).errorHint, 'AI 도구 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.');
});

test('runAgent reports the model from the first init event (claude, gemini) or the codex header', async () => {
  for (const [id, out, err, model] of [
    ['claude', '{"type":"system","subtype":"init","model":"claude-opus-4-5","tools":[]}\n{"type":"system","subtype":"init","model":"other"}\n', '', 'claude-opus-4-5'],
    ['gemini', '{"type":"init","session_id":"s","model":"gemini-2.5-pro"}\n', '', 'gemini-2.5-pro'],
    ['codex', 'workdir: /x\n', 'OpenAI Codex v0.50\nmodel: gpt-5-codex\nprovider: openai\n', 'gpt-5-codex'],
    ['claude', '{"type":"result","is_error":false}\n', '', undefined],
    ['gemini', '{"type":"init","model":"x\\u0000y"}\n', '', undefined],
  ]) {
    const { impl, calls } = fakeSpawn();
    const { done } = runAgent({ id, workdir: W, prompt: 'P', spawnImpl: impl, onLog() {} });
    calls[0].child.stdout.write(out);
    calls[0].child.stderr.write(err);
    calls[0].child.stdout.end(); calls[0].child.stderr.end();
    await tick();
    calls[0].child.emit('close', 0, null);
    assert.equal((await done).model, model, `${id} ${out}`);
  }
});

test('runAgent claude: never inherits the server\'s CLAUDE_CONFIG_DIR', async () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/inherited/dir';
  try {
    const a = fakeSpawn();
    runAgent({ id: 'claude', workdir: W, prompt: 'P', spawnImpl: a.impl, onLog() {} });
    assert.equal('CLAUDE_CONFIG_DIR' in a.calls[0].opts.env, false);
    assert.equal(a.calls[0].opts.env.PATH, process.env.PATH);
    const b = fakeSpawn();
    runAgent({ id: 'claude', workdir: W, prompt: 'P', configDir: '/h/.claude/yvin', spawnImpl: b.impl, onLog() {} });
    assert.equal(b.calls[0].opts.env.CLAUDE_CONFIG_DIR, '/h/.claude/yvin');
    assert.equal(process.env.CLAUDE_CONFIG_DIR, '/inherited/dir'); // the server env itself is untouched
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});
