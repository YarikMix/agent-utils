import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { LspClient } from '../src/lsp-client.ts'
import { pathToUri } from '../src/files.ts'
import { fakeLsp, recordedMessages, temporaryProject } from './support.ts'

const range = { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } }
const capabilities = { workspaceSymbolProvider: true, implementationProvider: true }

test('navigation retains multiple definitions, workspace files and implementation ranges', async () => {
  const project = await temporaryProject({ 'source.ts': 'export const x = 1', 'other.ts': 'x' })
  const file = join(project.root, 'source.ts'); const other = join(project.root, 'other.ts'); const log = join(project.root, 'wire.jsonl')
  const locations = [{ uri: pathToUri(file), range }, { targetUri: pathToUri(other), targetRange: range, targetSelectionRange: { start: range.start, end: range.start }, originSelectionRange: range }]
  const fake = fakeLsp({ log, capabilities, results: { 'textDocument/definition': locations, 'textDocument/implementation': locations, 'workspace/symbol': [
    { name: 'same', kind: 12, location: { uri: pathToUri(file), range } }, { name: 'same', kind: 12, location: { uri: pathToUri(other), range } },
  ] } })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  try {
    const definitions = await client.definition(file, 0, 0)
    assert.deepEqual(definitions.map(item => item.file), [file, other])
    assert.deepEqual(definitions[0]!.range, range)
    assert.deepEqual(await client.implementations(file, 0, 0), definitions)
    assert.deepEqual(await client.workspaceSymbols(file, 'same'), [file, other].map(file => ({ name: 'same', kind: 'function', file, line: 1, character: 2 })))
    const wire = await recordedMessages(log)
    assert.deepEqual(wire.find(m => m.method === 'workspace/symbol')!.params, { query: 'same' })
    assert.deepEqual(wire.find(m => m.method === 'textDocument/implementation')!.params, { textDocument: { uri: pathToUri(file) }, position: { line: 0, character: 0 } })
  } finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
})

for (const resolveProvider of [true, false]) {
  test(`workspace symbol without range requires resolveProvider=${resolveProvider}`, async () => {
    const project = await temporaryProject({ 'source.ts': 'x' }); const file = join(project.root, 'source.ts'); const log = join(project.root, 'wire.jsonl')
    const unresolved = { name: 'x', kind: 13, location: { uri: pathToUri(file) }, data: { opaque: ['native', 7] } }
    const fake = fakeLsp({ log, capabilities: { workspaceSymbolProvider: { resolveProvider } }, results: { 'workspace/symbol': [unresolved], 'workspaceSymbol/resolve': { ...unresolved, location: { uri: pathToUri(file), range } } } })
    const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
    try {
      if (resolveProvider) {
        assert.deepEqual(await client.workspaceSymbols(file, 'x'), [{ name: 'x', kind: 'variable', file, line: 1, character: 2 }])
        assert.deepEqual((await recordedMessages(log)).find(m => m.method === 'workspaceSymbol/resolve')!.params, unresolved)
      } else await assert.rejects(client.workspaceSymbols(file, 'x'), /resolve|range/i)
    } finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
  })
}

test('navigation rejects unsupported capabilities, invalid partial results and unresolved locations', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' }); const file = join(project.root, 'source.ts')
  for (const [caps, results, operation] of [
    [{ implementationProvider: false }, {}, (c: LspClient) => c.implementations(file, 0, 0)],
    [{ workspaceSymbolProvider: false }, {}, (c: LspClient) => c.workspaceSymbols(file, '')],
    [capabilities, { 'textDocument/implementation': [{ uri: pathToUri(file), range }, { broken: true }] }, (c: LspClient) => c.implementations(file, 0, 0)],
    [capabilities, { 'workspace/symbol': [{ name: 'ok', kind: 12, location: { uri: pathToUri(file), range } }, {}] }, (c: LspClient) => c.workspaceSymbols(file, '')],
    [{ workspaceSymbolProvider: { resolveProvider: true } }, { 'workspace/symbol': [{ name: 'x', kind: 12, location: { uri: pathToUri(file) } }], 'workspaceSymbol/resolve': { name: 'x', kind: 12, location: { uri: pathToUri(file) } } }, (c: LspClient) => c.workspaceSymbols(file, '')],
  ] as const) {
    const fake = fakeLsp({ capabilities: caps, results }); const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
    try { await assert.rejects(operation(client), /capability|protocol|range/i) }
    finally { await client.shutdown(); await fake.dispose() }
  }
  await project.dispose()
})
