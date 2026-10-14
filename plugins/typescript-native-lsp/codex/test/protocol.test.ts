import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { configurationResults, parseLocations, parseSymbols, parseWorkspaceEdit, requireCapability } from '../src/protocol.ts'
import { pathToUri } from '../src/files.ts'
import { LspClient } from '../src/lsp-client.ts'
import { fakeLsp, recordedMessages, temporaryProject } from './support.ts'

const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }
const file = join(process.platform === 'win32' ? 'C:\\' : '/', 'tmp', 'a #.ts')
const location = { uri: pathToUri(file), range }

test('Location and LocationLink single/array/null normalize and malformed responses throw', () => {
  assert.equal(parseLocations([location, { targetUri: location.uri, targetRange: range, targetSelectionRange: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } } }]).length, 2)
  assert.deepEqual(parseLocations(location), [{ file, line: 0, character: 0 }])
  assert.deepEqual(parseLocations(null), [])
  assert.throws(() => parseLocations([{}]), /protocol|location/i)
})

test('nested document symbols retain children, flat ambiguous names never merge or cycle', () => {
  const nested = parseSymbols([{ name: 'Class', kind: 5, range, selectionRange: range, children: [{ name: 'run', kind: 6, range, selectionRange: range }] }], file)
  assert.deepEqual(nested[0]!.children.map(s => s.name), ['run'])
  const flat = parseSymbols([{ name: 'A', kind: 5, location }, { name: 'A', kind: 5, location }, { name: 'run', kind: 6, location, containerName: 'A' }, { name: 'cycle', kind: 5, location, containerName: 'cycle' }], file)
  assert.equal(flat.length, 4); assert.equal(flat.flatMap(s => s.children).length, 0)
  assert.throws(() => parseSymbols([{}], file), /protocol|symbol/i)
})

test('capability failures are explicit; configuration follows requested order with nested inlay/ATA settings', () => {
  assert.throws(() => requireCapability('textDocument/hover', {}), /capability/i)
  requireCapability('textDocument/hover', { hoverProvider: {} })
  const results = configurationResults({ items: [{ section: 'editor' }, { section: 'js/ts' }, { section: 'javascript' }, { section: 'typescript' }] }) as any[]
  assert.equal(results[0].tabSize, 2)
  assert.equal(results[1].tsserver.automaticTypeAcquisition.enabled, false)
  for (const result of results.slice(1)) {
    assert.equal(result.inlayHints.parameterNames.enabled, 'all')
    assert.equal(result.inlayHints.variableTypes.enabled, true)
    assert.equal(result.inlayHints.functionLikeReturnTypes.enabled, true)
  }
})

test('pull diagnostics full/unchanged retains resultId and rejects malformed reports', async () => {
  const project = await temporaryProject({ 'source.ts': 'const x = 1' })
  const log = join(project.root, 'messages.jsonl')
  const fake = fakeLsp({ log, diagnosticReports: [{ kind: 'full', resultId: 'one', items: [{ range, code: 2322, message: 'bad' }] }, { kind: 'unchanged', resultId: 'two' }, { kind: 'garbage', items: [] }] })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  try {
    const first = await client.diagnostics(join(project.root, 'source.ts'))
    assert.equal(first.length, 1)
    assert.deepEqual(await client.diagnostics(join(project.root, 'source.ts')), first)
    await assert.rejects(client.diagnostics(join(project.root, 'source.ts')), /protocol|diagnostic/i)
    const queries = (await recordedMessages(log)).filter(m => m.method === 'textDocument/diagnostic')
    assert.equal(queries[1]!.params.previousResultId, 'one')
    assert.equal(queries[2]!.params.previousResultId, 'two')
  } finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
})

test('numeric full and object incremental textDocumentSync are negotiated', async () => {
  for (const syncKind of [1, { openClose: true, change: 2 }]) {
    const project = await temporaryProject({ 'source.ts': 'const x = 1' })
    const { writeFile } = await import('node:fs/promises')
    const log = join(project.root, 'messages.jsonl'); const fake = fakeLsp({ log, syncKind })
    const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
    try {
      await client.hover(join(project.root, 'source.ts'), 0, 0)
      await writeFile(join(project.root, 'source.ts'), 'const x = 2')
      await client.hover(join(project.root, 'source.ts'), 0, 0)
      const changes = (await recordedMessages(log)).filter(m => m.method === 'textDocument/didChange')
      assert.equal(changes.length, 1)
      assert.equal('range' in changes[0]!.params.contentChanges[0], typeof syncKind === 'object')
    } finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
  }
})

test('server configuration and registration requests receive substantive results or explicit errors', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const log = join(project.root, 'messages.jsonl')
  const fake = fakeLsp({ log, serverRequests: [
    { id: 'config', method: 'workspace/configuration', params: { items: [{ section: 'javascript' }, { section: 'js/ts' }, { section: 'editor' }] } },
    { id: 'bad', method: 'client/registerCapability', params: { registrations: [{ id: 'bad', method: 'unknown' }] } },
    { id: 'register', method: 'client/registerCapability', params: { registrations: [{ id: 'config-watch', method: 'workspace/didChangeConfiguration', registerOptions: { section: ['js/ts'] } }] } },
  ] })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  try {
    const { waitFor } = await import('./support.ts')
    await waitFor(async () => (await recordedMessages(log)).filter(m => ['config', 'bad', 'register'].includes(String(m.id))).length === 3)
    const records = await recordedMessages(log) as any[]
    assert.equal(records.find(m => m.id === 'config').result[0].inlayHints.parameterNames.enabled, 'all')
    assert.equal(records.find(m => m.id === 'config').result[1].tsserver.automaticTypeAcquisition.enabled, false)
    assert.equal(records.find(m => m.id === 'bad').error.code, -32602)
    assert.equal(records.find(m => m.id === 'register').result, null)
    const initialize = records.find(m => m.method === 'initialize')
    assert.equal(initialize.params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration, true)
  } finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
})

test('missing capability, invalid input positions and malformed hover/inlay reject clearly', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const fake = fakeLsp({ capabilities: { hoverProvider: false } })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  try {
    await assert.rejects(client.hover(join(project.root, 'source.ts'), 0, 0), /capability/i)
    await assert.rejects(client.definition(join(project.root, 'source.ts'), 0, 2), /position/i)
    await assert.rejects(client.hover(join(project.root, 'missing.ts'), 0, 0), /ENOENT/)
  } finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
})

test('MCP marks malformed diagnostics and missing files as isError', { skip: process.platform === 'win32' }, async () => {
  const { fileURLToPath } = await import('node:url')
  const { nativeProtocolPeer, openMcp } = await import('./support.ts')
  const project = await temporaryProject({ 'source.ts': 'x' })
  const binary = await nativeProtocolPeer(project.root, { diagnosticReports: [{ kind: 'full', items: 'malformed' }] })
  const session = await openMcp(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { ...process.env, TSC_PATH: binary })
  try {
    const malformed = await session.client.callTool({ name: 'diagnostics', arguments: { file: join(project.root, 'source.ts') } })
    const missing = await session.client.callTool({ name: 'diagnostics', arguments: { file: join(project.root, 'missing.ts') } })
    assert.equal(malformed.isError, true)
    assert.equal(missing.isError, true)
    assert.match(JSON.stringify(malformed.content), /protocol.*diagnostic/i)
    assert.match(JSON.stringify(missing.content), /ENOENT/)
  } finally { await session.close(); await project.dispose() }
})

test('quick fixes use the actual EOF range from the same diagnostic snapshot', async () => {
  const { TypeScriptPool } = await import('../src/pool.ts')
  const project = await temporaryProject({ 'source.ts': 'const x = 1\r\n😀' })
  const file = join(project.root, 'source.ts'); const log = join(project.root, 'messages.jsonl'); const fake = fakeLsp({ log })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: (binary, uri, options) => LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    await pool.diagnosticsWithFixes(file)
    const actions = (await recordedMessages(log)).find(m => m.method === 'textDocument/codeAction')!
    assert.deepEqual(actions.params.range, { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } })
  } finally { await pool.shutdown(); await fake.dispose(); await project.dispose() }
})

test('malformed members of hover content arrays cannot be dropped into successful partial responses', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const fake = fakeLsp({ results: { 'textDocument/hover': { contents: ['valid', {}] } } })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  try { await assert.rejects(client.hover(join(project.root, 'source.ts'), 0, 0), /protocol|hover/i) }
  finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
})

test('flat SymbolInformation hierarchy follows unambiguous containerName without range containment guesses', () => {
  const symbols = parseSymbols([
    { name: 'A', kind: 5, location: { uri: location.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
    { name: 'run', kind: 6, containerName: 'A', location: { uri: location.uri, range: { start: { line: 10, character: 0 }, end: { line: 10, character: 3 } } } },
  ], file)
  assert.equal(symbols.length, 1)
  assert.deepEqual(symbols[0]!.children.map(s => s.name), ['run'])
})

test('valid empty workspace edits remain empty while malformed edit data rejects', () => {
  assert.deepEqual(parseWorkspaceEdit(null), [])
  assert.deepEqual(parseWorkspaceEdit({}), [])
  assert.deepEqual(parseWorkspaceEdit({ changes: {} }), [])
  assert.throws(() => parseWorkspaceEdit({ changes: { [location.uri]: [{}] } }), /protocol|edit/i)
})
