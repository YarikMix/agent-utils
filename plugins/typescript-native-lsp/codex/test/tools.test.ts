import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToUri } from '../src/files.ts'
import { nativeProtocolPeer, openMcp, recordedMessages, temporaryProject, waitFor } from './support.ts'

const expectedToolNames = ['hover', 'diagnostics', 'references', 'outline', 'rename', 'inlay_hints', 'definition', 'workspace_symbols', 'implementations', 'prepare_call_hierarchy', 'incoming_calls', 'outgoing_calls']
test('MCP discovery exposes exactly 12 annotated tools and versioned server metadata', async () => {
  const session = await openMcp(join(process.cwd(), 'src/index.ts'), { PATH: '', TSC_PATH: '' })
  try {
    const { tools } = await session.client.listTools()
    assert.equal(tools.length, 12); assert.deepEqual(tools.map(t => t.name).sort(), expectedToolNames.sort())
    assert.equal(tools.find(t => t.name === 'rename')!.annotations!.readOnlyHint, false)
    assert.equal(tools.find(t => t.name === 'rename')!.annotations!.destructiveHint, true)
    assert.ok(tools.filter(t => t.name !== 'rename').every(t => t.annotations!.readOnlyHint === true))
    assert.ok(tools.every(t => t.annotations!.openWorldHint === false))
    assert.deepEqual(session.client.getServerVersion(), { name: 'typescript-native-lsp', version: '1.1.0' })
    const args = tools.find(t => t.name === 'incoming_calls')!.inputSchema.properties!
    assert.deepEqual(Object.keys(args).sort(), ['file', 'item_id'])
  } finally { await session.close() }
})

test('MCP new navigation results are JSON and errors remain errors', { skip: process.platform === 'win32' }, async () => {
  const project = await temporaryProject({ 'source.ts': 'x' }); const file = join(project.root, 'source.ts'); const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  const item = { name: 'x', kind: 12, uri: pathToUri(file), range, selectionRange: range, data: { secretNative: true } }
  const binary = await nativeProtocolPeer(project.root, { capabilities: { workspaceSymbolProvider: true, implementationProvider: true, callHierarchyProvider: true }, results: { 'textDocument/definition': [{ uri: item.uri, range }], 'workspace/symbol': [{ name: 'x', kind: 12, location: { uri: item.uri, range } }], 'textDocument/implementation': [{ uri: item.uri, range }], 'textDocument/prepareCallHierarchy': [item], 'callHierarchy/incomingCalls': [{ from: item, fromRanges: [range] }], 'callHierarchy/outgoingCalls': [{ to: item, fromRanges: [range] }] } })
  const session = await openMcp(join(process.cwd(), 'src/index.ts'), { ...process.env, TSC_PATH: binary })
  try {
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const response = await session.client.callTool({ name, arguments: { file, ...args } }); assert.notEqual(response.isError, true)
      return JSON.parse((response.content as Array<{ text: string }>)[0]!.text)
    }
    assert.equal((await invoke('definition', { line: 0, character: 0 }))[0].file, file)
    assert.equal((await invoke('workspace_symbols', { query: 'x' }))[0].name, 'x')
    assert.equal((await invoke('implementations', { line: 0, character: 0 }))[0].file, file)
    const [prepared] = await invoke('prepare_call_hierarchy', { line: 0, character: 0 })
    for (const name of ['incoming_calls', 'outgoing_calls']) assert.deepEqual((await invoke(name, { item_id: prepared.item_id }))[0].fromRanges, [range])
    const error = await session.client.callTool({ name: 'incoming_calls', arguments: { file, item_id: 'forged' } }); assert.equal(error.isError, true)
  } finally { await session.close(); await project.dispose() }
})

test('MCP AbortSignal reaches pending native request', { skip: process.platform === 'win32' }, async () => {
  const project = await temporaryProject({ 'source.ts': 'abc' }); const file = join(project.root, 'source.ts'); const log = join(project.root, 'wire.jsonl')
  const binary = await nativeProtocolPeer(project.root, { log, delayFirst: 3000 })
  const session = await openMcp(join(process.cwd(), 'src/index.ts'), { ...process.env, TSC_PATH: binary })
  try {
    const controller = new AbortController()
    const pending = session.client.callTool({ name: 'hover', arguments: { file, line: 0, character: 1 } }, undefined, { signal: controller.signal }).catch(error => error)
    await waitFor(async () => (await recordedMessages(log)).some(m => m.method === 'textDocument/hover'))
    controller.abort(); await pending
    await waitFor(async () => (await recordedMessages(log)).some(m => m.method === '$/cancelRequest'))
  } finally { await session.close(); await project.dispose() }
})
