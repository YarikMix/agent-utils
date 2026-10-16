import { afterEach, expect, it } from 'vitest';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(root, 'plugins/apple-notes-folder');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const claudeCatalogBaseline = [
  {
    "name": "typescript-native-lsp",
    "description": "TypeScript 7 native language server (tsc --lsp) for Claude Code",
    "version": "1.0.0",
    "author": {
      "name": "Yaroslav Mihalev"
    },
    "source": "./plugins/typescript-native-lsp",
    "category": "development",
    "strict": false,
    "lspServers": {
      "typescript": {
        "command": "tsc",
        "args": [
          "--lsp",
          "--stdio"
        ],
        "extensionToLanguage": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact",
          ".mts": "typescript",
          ".cts": "typescript",
          ".mjs": "javascript",
          ".cjs": "javascript"
        }
      }
    }
  },
  {
    "name": "selectel-ops",
    "description": "Работа с облаком Selectel: доступ, проекты, флейворы, DNS, диагностика, стык с Pulumi и Ansible",
    "version": "1.0.0",
    "author": {
      "name": "Yaroslav Mihalev"
    },
    "source": "./plugins/selectel-ops",
    "category": "development",
    "strict": false
  }
];
const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

// This regression targets the legacy loader in exactly Codex 0.162.1.
// Missing/other CLI versions skip only this host integration; artifact tests still run.
const cliEnv = { PATH: process.env.PATH ?? '' };
const codexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8', env: cliEnv }).stdout?.trim();
it.skipIf(codexVersion !== 'codex-cli 0.162.1')('Codex 0.162.1 starts seven production tools from its dependency-free installed cache', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'apple-notes-codex-install-'))); temporary.push(dir);
  const source = join(dir, 'marketplace');
  const project = join(dir, 'unrelated-project');
  const env = { ...cliEnv, CODEX_HOME: join(dir, 'codex-profile') };
  await mkdir(env.CODEX_HOME);
  await mkdir(join(source, '.agents/plugins'), { recursive: true });
  await mkdir(project);
  await writeFile(join(source, '.agents/plugins/marketplace.json'), await readFile(join(root, '.agents/plugins/marketplace.json')));
  await cp(plugin, join(source, 'plugins/apple-notes-folder'), { recursive: true,
    filter: path => !path.split('/').includes('node_modules') });
  for (const args of [['plugin', 'marketplace', 'add', source, '--json'], ['plugin', 'add', 'apple-notes-folder@yarikmix-plugins', '--json']]) {
    const result = spawnSync('codex', args, { cwd: project, env, encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
  }
  const cache = join(env.CODEX_HOME, 'plugins/cache/yarikmix-plugins/apple-notes-folder/2.0.0');
  expect(await lstat(join(cache, 'node_modules')).catch(() => null)).toBe(null);
  // Removing the marketplace's plugin copy proves startup uses the installed cache.
  await rm(join(source, 'plugins'), { recursive: true });
  const child = spawn('codex', ['app-server', '--stdio'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  lines.on('line', line => { const response = JSON.parse(line); if (response.id !== undefined) pending.get(response.id)?.resolve(response); });
  child.once('exit', () => { for (const request of pending.values()) request.reject(new Error(`Codex app-server exited: ${stderr}`)); });
  const request = async (id: number, method: string, params: object) => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Codex ${method} timed out: ${stderr}`)), 20_000);
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    } finally { clearTimeout(timer!); pending.delete(id); }
  };
  try {
    const init = await request(1, 'initialize', { clientInfo: { name: 'apple-notes-packaging-test', version: '1' }, capabilities: { experimentalApi: true } });
    expect(init.error).toBeUndefined();
    child.stdin.write('{"method":"initialized"}\n');
    // No thread/turn/model request: this inventory endpoint starts MCP directly.
    const result = await request(2, 'mcpServerStatus/list', { serverName: 'apple-notes-folder' });
    expect(result.error).toBeUndefined();
    expect(result.result.data).toHaveLength(1);
    const server = result.result.data[0];
    expect(server.toolsError).toBeNull();
    expect(server.serverInfo).toMatchObject({ name: 'apple-notes-folder', version: '2.0.0' });
    expect(Object.keys(server.tools).sort()).toEqual(['notes_append', 'notes_create', 'notes_delete', 'notes_list', 'notes_read', 'notes_search', 'notes_update']);
    expect(stderr).not.toMatch(/MODULE_NOT_FOUND|responses_websocket|api\.openai\.com/);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
  }
}, 60_000);

it('keeps eight release versions and unrelated Claude catalog behavior', async () => {
  const pkg = await json(join(plugin, 'package.json'));
  const lock = await json(join(plugin, 'package-lock.json'));
  const claude = await json(join(plugin, '.claude-plugin/plugin.json'));
  const codex = await json(join(plugin, '.codex-plugin/plugin.json'));
  const cc = await json(join(root, '.claude-plugin/marketplace.json'));
  const cx = await json(join(root, '.agents/plugins/marketplace.json'));
  const version = (await readFile(join(plugin, 'src/version.ts'), 'utf8')).match(/VERSION\s*=\s*['"]([^'"]+)/)![1];
  expect([pkg.version, lock.version, lock.packages[''].version, version, claude.version, codex.version,
    cc.plugins.at(-1).version, cx.plugins[0].version]).toEqual(Array(8).fill('2.0.0'));
  expect(claude.userConfig.folder.required).toBe(true);
  expect(cc.plugins.map((p: {name: string}) => p.name)).toEqual(['typescript-native-lsp', 'selectel-ops', 'apple-notes-folder']);
  expect(cc.plugins.slice(0, 2)).toEqual(claudeCatalogBaseline);
  expect(cx.name).toBe('yarikmix-plugins');
  expect(cx.plugins.map((p: {name: string}) => p.name)).toEqual(['apple-notes-folder']);
  expect(cx.plugins[0]).toMatchObject({ source: { source: 'local', path: './plugins/apple-notes-folder' }, category: 'Productivity', policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } });
});

it('resolves copied installation without node_modules or a build', async () => {
  const cache = await realpath(await mkdtemp(join(tmpdir(), 'apple-notes-package-'))); temporary.push(cache);
  await cp(plugin, cache, { recursive: true, filter: source => !source.split('/').includes('node_modules') });
  expect((await readdir(join(cache, 'dist'))).sort()).toEqual(['configure.js', 'hook.js', 'server.js']);
  expect(await lstat(join(cache, 'node_modules')).catch(() => null)).toBe(null);
  const claude = await json(join(cache, '.claude-plugin/plugin.json'));
  const codex = await json(join(cache, '.codex-plugin/plugin.json'));
  expect(codex).toMatchObject({ name: 'apple-notes-folder', mcpServers: './.mcp.json', skills: './skills/', hooks: './hooks/codex.json', extensions: { 'com.openai': { onboardingSkill: './skills/setup/SKILL.md' } } });
  expect(claude.hooks).toBe('./hooks/claude.json');
  expect(await lstat(join(cache, 'hooks/hooks.json')).catch(() => null)).toBe(null);
  const mcp = await json(join(cache, codex.mcpServers));
  expect(mcp.mcpServers['apple-notes-folder']).toEqual({ command: 'node', cwd: '.', args: ['./dist/server.js', '--client', 'codex'] });
  expect(claude.mcpServers['apple-notes-folder']).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js', '--client', 'claude'], env: { NOTES_FOLDER: '${user_config.folder}' } });
  for (const host of ['claude', 'codex']) {
    const hooks = await json(join(cache, host === 'claude' ? claude.hooks : codex.hooks));
    expect(hooks.hooks.PreToolUse).toHaveLength(2);
    const prefix = host === 'claude' ? 'mcp__plugin_apple-notes-folder_apple-notes-folder__' : 'mcp__apple_notes_folder__';
    expect(hooks.hooks.PreToolUse[1].matcher).toBe(['notes_create', 'notes_append', 'notes_update'].map(name => prefix + name).join('|'));
    expect(hooks.hooks.PreToolUse[0].matcher).toBe(host === 'claude' ? 'Bash|Monitor' : 'Bash');
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);
    for (const entry of [...hooks.hooks.PreToolUse, ...hooks.hooks.UserPromptSubmit])
      expect(entry.hooks[0].command).toBe(`node "${host === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}'}/dist/hook.js" --client ${host}`);
  }
  const walk = async (dir: string): Promise<void> => { for (const name of await readdir(dir)) { const path = join(dir, name); const stat = await lstat(path); expect(stat.isSymbolicLink()).toBe(false); if (stat.isDirectory()) await walk(path); } };
  await walk(join(cache, codex.skills));
  const skill = await readFile(join(cache, codex.extensions['com.openai'].onboardingSkill), 'utf8');
  expect(skill).toMatch(/^---\nname: setup\ndescription: Use when.*Codex/m);
  expect(skill).toContain('dist/configure.js');
  expect(skill).toContain('/plugin configure apple-notes-folder@yarikmix-plugins');
  for (const key of ['logo', 'composerIcon']) expect(await readFile(join(cache, codex.interface[key]), 'utf8')).toContain('viewBox="0 0 64 64"');
  expect(codex.interface.displayName).toBeTruthy(); expect(codex.interface.shortDescription).toBeTruthy();
  const configure = spawnSync(process.execPath, [join(cache, 'dist/configure.js')], { encoding: 'utf8' });
  expect(configure.status).toBe(1); expect(configure.stderr).toContain('--folder');
  await symlink(join(cache, 'dist/configure.js'), join(cache, 'configure-alias.js'));
  const alias = spawnSync(process.execPath, [join(cache, 'configure-alias.js')], { encoding: 'utf8' });
  expect(alias.status).toBe(1); expect(alias.stderr).toContain('--folder');
  for (const host of ['claude', 'codex']) {
    const hook = spawnSync(process.execPath, [join(cache, 'dist/hook.js'), '--client', host], { input: '{}', encoding: 'utf8' });
    expect(hook.status).toBe(0); expect(hook.stdout).toBe('');
    const client = new Client({ name: 'cached-distribution', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [join(cache, 'dist/server.js'), '--client', host],
        env: { CODEX_HOME: join(cache, 'codex-profile'), CLAUDE_CONFIG_DIR: join(cache, 'claude-profile'), NOTES_FOLDER: '' } }));
      expect(client.getServerVersion()).toEqual({ name: 'apple-notes-folder', version: '2.0.0' });
      expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual([
        'notes_append', 'notes_create', 'notes_delete', 'notes_list', 'notes_read', 'notes_search', 'notes_update',
      ]);
      const result = await client.callTool({ name: 'notes_list', arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as {text: string}[])[0].text).toContain(host === 'codex' ? '$apple-notes-folder:setup' : '/plugin configure');
    } finally { await client.close(); }
  }
});
