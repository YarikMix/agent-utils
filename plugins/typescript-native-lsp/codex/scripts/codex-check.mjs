import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export const expectedTools = ['hover', 'diagnostics', 'references', 'outline', 'rename', 'inlay_hints', 'definition', 'workspace_symbols', 'implementations', 'prepare_call_hierarchy', 'incoming_calls', 'outgoing_calls'].sort();
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = resolve(packageRoot, '../../..');
const within = (root, path) => path === root || path.startsWith(root + sep);

/** Remove npm's checkout injection without printing inherited environment/credentials. */
export async function cleanEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  const entries = [];
  for (const path of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(path) || /node_modules[/\\]\.bin(?:[/\\]|$)/.test(path)) continue;
    let canonical;
    try { canonical = await realpath(path); } catch { continue; }
    if (!within(checkout, canonical)) entries.push(path);
  }
  env.PATH = entries.join(delimiter);
  delete env.NODE_PATH;
  if (env.TSC_PATH) {
    assert.ok(isAbsolute(env.TSC_PATH), 'TSC_PATH must be absolute');
    assert.ok(!within(checkout, await realpath(env.TSC_PATH)), 'Installed check cannot use the checkout compiler');
  }
  return env;
}

export async function command(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    const killer = setTimeout(() => child.kill('SIGKILL'), 125_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); clearTimeout(killer); resolvePromise({ code, signal, stdout, stderr }); });
  });
}

/** One owned stdio AppServer. No shared daemon, registration or auth access. */
export class AppServer {
  constructor(env, args = [], cwd = tmpdir(), record = () => {}, onServerRequest = null) {
    this.nextId = 0; this.pending = new Map(); this.events = []; this.record = record;
    this.child = spawn('codex', [...args, 'app-server', '--listen', 'stdio://'], { env, cwd, stdio: 'pipe', shell: false });
    this.child.stderr.on('data', chunk => { process.stderr.write(chunk); record({ stderr: chunk.toString() }); });
    this.closed = new Promise(resolveClose => this.child.once('close', resolveClose));
    this.child.on('error', error => { for (const p of this.pending.values()) p.reject(error); });
    this.child.on('close', () => { for (const p of this.pending.values()) p.reject(new Error('AppServer closed')); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { record({ invalidStdout: line }); return; }
      record({ received: message });
      if (message.method && message.id !== undefined) {
        try {
          if (!onServerRequest) throw new Error('Interactive requests unsupported by isolated check');
          const result = onServerRequest(message, this);
          if (result === undefined || result instanceof Promise) throw new Error('Synchronous approval response required');
          record({ sent: { id: message.id, result } });
          this.child.stdin.write(JSON.stringify({ id: message.id, result }) + '\n');
        } catch (error) {
          record({ rejectedServerRequest: { id: message.id, reason: String(error) } });
          this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported interactive request' } }) + '\n');
          this.events.push({ method: 'harness/unexpectedRequest', params: message });
        }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result); }
      } else this.events.push(message);
    });
  }
  request(method, params, timeout = 60_000) {
    const id = ++this.nextId;
    this.record({ sent: { id, method, params } });
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'typescript-native-lsp-check', version: '1.1.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write('{"method":"initialized"}\n');
  }
  async close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('AppServer closing')); }
    this.pending.clear();
    this.child.stdin.end();
    const term = setTimeout(() => this.child.kill('SIGTERM'), 3000);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 7000);
    await this.closed; clearTimeout(term); clearTimeout(kill);
  }
}

export async function inventory(app, threadId) {
  const data = []; let cursor;
  do {
    const page = await app.request('mcpServerStatus/list', { threadId, cursor, limit: 100 });
    data.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  return data;
}
export async function installedServer(app, threadId) {
  const servers = await inventory(app, threadId);
  const matches = servers.filter(server => Object.values(server.tools).some(tool => tool.name === 'prepare_call_hierarchy'));
  assert.equal(matches.length, 1, 'Exactly one TypeScript MCP server in isolated inventory');
  const server = matches[0];
  assert.deepEqual(Object.values(server.tools).map(tool => tool.name).sort(), expectedTools);
  for (const tool of Object.values(server.tools)) assert.equal(tool.annotations?.readOnlyHint, tool.name !== 'rename');
  return { server, servers };
}
export async function call(app, threadId, server, tool, args) {
  const result = await app.request('mcpServer/tool/call', { threadId, server, tool, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result;
}
export function contentText(result) { return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'); }

async function allFiles(root) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    assert.notEqual(item.name, 'node_modules', 'Installed package must not contain node_modules');
    assert.ok(!item.isSymbolicLink(), 'Installed cache must contain copied files, not checkout symlinks');
    const path = join(root, item.name);
    if (item.isDirectory()) result.push(...await allFiles(path)); else result.push(path);
  }
  return result;
}

export async function main(args = process.argv.slice(2)) {
  let marketplace, ref, keepTemp = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--marketplace') marketplace = args[++i];
    else if (args[i] === '--ref') ref = args[++i];
    else if (args[i] === '--keep-temp') keepTemp = true;
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  assert.ok(marketplace && !marketplace.startsWith('--'), 'Usage: codex-check.mjs --marketplace <root-or-url> [--ref <ref>] [--keep-temp]');
  const tempRoot = await mkdtemp(join(tmpdir(), 'typescript-codex-check-'));
  const codexHome = join(tempRoot, 'codex-home');
  const fixture = join(tempRoot, 'fixture');
  const report = { ok: false, tempRoot, codexHome, retained: keepTemp, checks: [] };
  let app, threadId;
  const transcript = [];
  try {
    await mkdir(codexHome); await mkdir(fixture);
    await writeFile(join(fixture, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"target":"ES2022"}}\n');
    await writeFile(join(fixture, 'sample.ts'), 'export function twice(value: number): number { return value * 2; }\nexport const result = twice(3);\nexport const broken: number = "wrong";\n');
    await writeFile(join(codexHome, 'config.toml'), '[features]\nplugins = true\nhooks = false\napps = false\nremote_plugin = false\n');
    const env = await cleanEnvironment({ CODEX_HOME: codexHome });
    const version = await command('codex', ['--version'], { env, cwd: tempRoot });
    assert.equal(version.code, 0); report.codexVersion = version.stdout.trim();
    const addMarket = await command('codex', ['plugin', 'marketplace', 'add', marketplace, ...(ref ? ['--ref', ref] : [])], { env, cwd: tempRoot });
    report.marketplace = addMarket; assert.equal(addMarket.code, 0, addMarket.stdout);
    const add = await command('codex', ['plugin', 'add', 'typescript-native-lsp@yarikmix-plugins', '--json'], { env, cwd: tempRoot });
    report.install = add; assert.equal(add.code, 0, add.stdout);
    const files = await allFiles(join(codexHome, 'plugins/cache'));
    const manifests = [];
    for (const path of files.filter(path => path.endsWith(`${sep}plugin.json`))) {
      if (JSON.parse(await readFile(path, 'utf8')).name === 'typescript-native-lsp') manifests.push(path);
    }
    assert.equal(manifests.length, 1, 'One copied portable manifest in installed cache');
    const cacheRoot = await realpath(dirname(manifests[0])); report.cacheRoot = cacheRoot;
    assert.ok(within(await realpath(codexHome), cacheRoot));
    const mcp = JSON.parse(await readFile(join(cacheRoot, 'mcp.json'), 'utf8')).mcpServers.typescript_native_lsp;
    assert.equal(mcp.cwd, './'); assert.equal(mcp.command, 'node'); assert.deepEqual(mcp.args, ['./dist/server.js']);
    report.checks.push('copied-cache/no-node_modules/relative-runtime');
    app = new AppServer(env, [], fixture, entry => transcript.push(entry));
    await app.initialize();
    const thread = await app.request('thread/start', { cwd: fixture, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write' });
    threadId = thread.thread.id;
    const { server, servers } = await installedServer(app, threadId);
    report.inventory = servers;
    assert.equal(server.pluginId, 'typescript-native-lsp@yarikmix-plugins', 'Server must come from installed plugin, not direct config');
    const skills = await app.request('skills/list', { cwds: [fixture], forceReload: true });
    report.skills = skills;
    const skill = skills.data.flatMap(entry => entry.skills).find(skill => skill.name === 'typescript-native-lsp:typescript-native-lsp');
    // Live tools are exercised even for the preliminary missing-skill component RED.
    const file = join(fixture, 'sample.ts');
    report.calls = {};
    for (const [name, args] of Object.entries({ hover: { file, line: 0, character: 17 }, references: { file, line: 0, character: 17 }, diagnostics: { file }, definition: { file, line: 1, character: 24 } })) {
      report.calls[name] = await call(app, threadId, server.name, name, args);
    }
    assert.match(contentText(report.calls.hover), /twice/);
    assert.match(contentText(report.calls.references), /sample\.ts/);
    assert.match(contentText(report.calls.diagnostics), /TS2322/);
    assert.match(contentText(report.calls.definition), /sample\.ts/);
    report.checks.push('12-tools/plugin-provenance/hover/references/diagnostics/definition');
    await writeFile(join(tempRoot, 'app-server.jsonl'), transcript.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    assert.ok(skill, 'Installed skill typescript-native-lsp must be discovered');
    assert.equal(await realpath(skill.path), join(cacheRoot, 'skills/typescript-native-lsp/SKILL.md'));
    assert.equal(skill.pluginId, 'typescript-native-lsp@yarikmix-plugins');
    assert.notEqual(skill.enabled, false);
    report.checks.push('installed-cache-skill'); report.ok = true;
  } catch (error) { report.error = String(error); process.exitCode = 1; }
  finally {
    if (app) {
      await app.close();
    }
    if (keepTemp) await writeFile(join(tempRoot, 'app-server.jsonl'), transcript.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    if (keepTemp) await writeFile(join(tempRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    else await rm(tempRoot, { recursive: true, force: true });
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
