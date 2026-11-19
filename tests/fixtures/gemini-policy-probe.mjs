// Child-process helper for tests/agent.test.mjs: loads our generated Gemini policy through the REAL installed
// Gemini CLI policy loader + engine (never runs a prompt) and prints one JSON line with the decisions.
// argv: <gemini bundle dir> <path to src/agent/commands.mjs> <workdir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [bundleDir, commandsPath, wd] = process.argv.slice(2);
const chunk = fs.readdirSync(bundleDir).filter((f) => f.endsWith('.js'))
  .find((f) => /\n {2}createPolicyEngineConfig,\n/.test(fs.readFileSync(path.join(bundleDir, f), 'utf8')));
if (!chunk) { console.log(JSON.stringify({ error: 'policy loader not found in bundle' })); process.exit(0); }
// Keep the bundle's debug logging out of stdout; the result goes out through the saved writer.
const out = process.stdout.write.bind(process.stdout);
console.log = console.debug = console.info = console.warn = console.error = () => {};
const m = await import(pathToFileURL(path.join(bundleDir, chunk)).href);
const feedback = [];
m.coreEvents.on('user-feedback', (p) => feedback.push(`${p.severity}: ${p.message}`));
const { agentCommand } = await import(pathToFileURL(commandsPath).href);
const { files } = agentCommand('gemini', { workdir: wd, prompt: 'P' });
const policyFile = path.join(wd, '.gemini-policy.toml');
fs.writeFileSync(policyFile, files['.gemini-policy.toml']);
const cfg = await m.createPolicyEngineConfig({ policyPaths: [policyFile] }, 'autoEdit', undefined, false);
const ours = cfg.rules.filter((r) => String(r.source ?? '').includes('.gemini-policy.toml')).length;
const engine = new m.PolicyEngine({ ...cfg, nonInteractive: true, approvalMode: 'autoEdit' });
const real = fs.realpathSync(wd);
const cases = {
  ...Object.fromEntries(['paper.txt', 'figures.txt', 'digest.md', 'TASK.md', 'digest.json'].flatMap((n) => [
    [`read ${n}`, ['read_file', { file_path: n }]],
    [`read abs ${n}`, ['read_file', { file_path: path.join(real, n) }]],
  ])),
  'list .': ['list_directory', { dir_path: '.' }],
  'write digest.json': ['write_file', { file_path: 'digest.json', content: '{}' }],
  'write abs digest.json': ['write_file', { file_path: path.join(real, 'digest.json'), content: '{}' }],
  'write tmpdir digest.json': ['write_file', { file_path: path.join(wd, 'digest.json'), content: '{}' }],
  'replace abs digest.json': ['replace', { file_path: path.join(real, 'digest.json'), old_string: 'a', new_string: 'b' }],
  'write outside': ['write_file', { file_path: '/Users/someone/.zshrc', content: '"file_path":"digest.json"' }],
  'write ../': ['write_file', { file_path: '../digest.json', content: '{}' }],
  'write ../ under wd': ['write_file', { file_path: `${real}/../digest.json`, content: '{}' }],
  'write TASK.md': ['write_file', { file_path: 'TASK.md', content: 'x' }],
  'read ../': ['read_file', { file_path: '../paper.txt' }],
  'read ssh': ['read_file', { file_path: '/Users/someone/.ssh/id_rsa' }],
  'list /': ['list_directory', { dir_path: '/' }],
  shell: ['run_shell_command', { command: 'ls' }],
  web_fetch: ['web_fetch', { prompt: 'http://example.com' }],
  google_web_search: ['google_web_search', { query: 'x' }],
  unknown: ['some_unknown_tool', {}],
  glob: ['glob', { pattern: '**/*' }],
};
const decisions = {};
for (const [k, [name, args]] of Object.entries(cases)) decisions[k] = (await engine.check({ name, args })).decision;
// Secure mode / security.disableAlwaysAllow skips "always allow" (.950) rules: ours must still hold.
const strict = new m.PolicyEngine({ ...cfg, nonInteractive: true, approvalMode: 'autoEdit', disableAlwaysAllow: true });
const strictDecisions = {};
for (const k of ['unknown', 'glob', 'write outside', 'read paper.txt', 'write digest.json']) {
  const [name, args] = cases[k];
  strictDecisions[k] = (await strict.check({ name, args })).decision;
}
out(`${JSON.stringify({ chunk, ours, feedback, decisions, strictDecisions })}\n`);
process.exit(0);
