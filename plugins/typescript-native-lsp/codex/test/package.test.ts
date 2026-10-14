import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '../../..')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const names = ['hover', 'diagnostics', 'references', 'outline', 'rename', 'inlay_hints', 'definition', 'workspace_symbols', 'implementations', 'prepare_call_hierarchy', 'incoming_calls', 'outgoing_calls'].sort()

test('portable marketplace resolves an independently runnable package, twelve annotations and lazy compiler failure', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'codex-package-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const target = join(temp, 'plugins/typescript-native-lsp/codex')
  await mkdir(join(temp, '.agents/plugins'), { recursive: true })
  await cp(join(repo, '.agents/plugins/marketplace.json'), join(temp, '.agents/plugins/marketplace.json'))
  await mkdir(target, { recursive: true })
  for (const file of ['plugin.json', 'mcp.json', 'package.json', 'dist', 'skills', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(join(root, file), join(target, file), { recursive: true })
  }
  const market = await json(join(temp, '.agents/plugins/marketplace.json'))
  assert.equal(market.name, 'yarikmix-plugins')
  assert.equal(market.plugins.length, 1)
  const entry = market.plugins[0]
  assert.deepEqual(entry.source, { source: 'local', path: './plugins/typescript-native-lsp/codex' })
  assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' })
  assert.equal(entry.category, 'Developer Tools')
  assert.equal(resolve(temp, entry.source.path), target)
  const plugin = await json(join(target, 'plugin.json'))
  const mcp = await json(join(target, 'mcp.json'))
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  assert.equal(plugin.name, 'typescript-native-lsp')
  assert.equal(plugin.version, '1.1.0')
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
  const server = mcp.mcpServers.typescript_native_lsp
  assert.deepEqual(server, { type: 'stdio', command: 'node', args: ['./dist/server.js'], cwd: './' })
  await assert.rejects(access(join(target, 'node_modules')))
  const skill = await readFile(join(target, 'skills/typescript-native-lsp/SKILL.md'), 'utf8')
  assert.match(skill, /^---\r?\nname: typescript-native-lsp\r?\ndescription: .+\r?\n---/)
  await mkdir(join(temp, 'empty-bin'))
  const transport = new StdioClientTransport({ command: process.execPath, args: server.args, cwd: resolve(target, server.cwd), env: { PATH: join(temp, 'empty-bin'), TSC_PATH: join(temp, 'missing-native-tsc'), NODE_PATH: '' }, stderr: 'pipe' })
  const client = new Client({ name: 'package-test', version: '1' })
  t.after(() => client.close())
  await client.connect(transport)
  const tools = (await client.listTools()).tools
  assert.equal(tools.length, 12)
  assert.deepEqual(tools.map(tool => tool.name).sort(), names)
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, tool.name !== 'rename', tool.name)
  await writeFile(join(temp, 'source.ts'), 'const value = 1;\n')
  const failed = await client.callTool({ name: 'hover', arguments: { file: join(temp, 'source.ts'), line: 0, character: 0 } })
  assert.equal(failed.isError, true)
  assert.match(JSON.stringify(failed.content), /TSC_PATH|native|TypeScript|binary/)
})

test('Claude retains three plugins, original native LSP configuration and other plugin versions', async () => {
  const current = await json(join(repo, '.claude-plugin/marketplace.json'))
  // Snapshot independently captured from eed751aca38991ab547a314a4401ce84fe54e0cf; works in shallow CI.
  const original = await json(join(root, 'test/fixtures/claude-marketplace-baseline.json'))
  assert.equal(current.name, 'yarikmix-plugins')
  assert.equal(current.plugins.length, 3)
  const ts = current.plugins.find((p: any) => p.name === 'typescript-native-lsp')
  assert.equal(ts.version, '1.1.0')
  assert.deepEqual(ts.lspServers, original.plugins.find((p: any) => p.name === ts.name).lspServers)
  assert.deepEqual(current.plugins.filter((p: any) => p.name !== ts.name), original.plugins.filter((p: any) => p.name !== ts.name))
})
