import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { LspClient } from '../src/lsp-client.ts'
import { TypeScriptPool } from '../src/pool.ts'
import { HierarchyStore } from '../src/hierarchy.ts'
import { pathToUri } from '../src/files.ts'
import { fakeLsp, recordedMessages, temporaryProject, waitFor } from './support.ts'

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
const item = (file: string, data: unknown = { native: ['opaque', { value: 7 }] }) => ({ name: 'same', kind: 12, uri: pathToUri(file), range, selectionRange: range, detail: 'detail', tags: [1], data })

test('opaque store isolates instances, generations and cleared entries without losing data', () => {
  const original = item('/tmp/source.ts'); const store = new HierarchyStore(); const other = new HierarchyStore()
  const first = store.put(original, 1); const second = store.put(original, 1)
  assert.notEqual(first.item_id, second.item_id)
  assert.match(first.item_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(store.get(first.item_id, 1), original)
  assert.equal('data' in first, false)
  assert.throws(() => other.get(first.item_id, 1), /item.*invalid/i)
  assert.throws(() => store.get('forged', 1), /item.*invalid/i)
  assert.throws(() => store.get(first.item_id, 2), /item.*invalid/i)
  store.clear(); assert.throws(() => store.get(second.item_id, 1), /item.*invalid/i)
})

test('call edges preserve native items, ranges and further traversal IDs in both directions', async () => {
  const project = await temporaryProject({ 'source.ts': 'x', 'caller.ts': 'x', 'callee.ts': 'x' }); const file = join(project.root, 'source.ts'); const caller = join(project.root, 'caller.ts'); const callee = join(project.root, 'callee.ts'); const log = join(project.root, 'wire.jsonl')
  const original = item(file); const incoming = item(caller, { caller: true }); const outgoing = item(callee, { callee: true })
  const fake = fakeLsp({ log, capabilities: { callHierarchyProvider: true }, results: { 'textDocument/prepareCallHierarchy': [original, { ...original, data: 'overload' }], 'callHierarchy/incomingCalls': [{ from: incoming, fromRanges: [range, range] }], 'callHierarchy/outgoingCalls': [{ to: outgoing, fromRanges: [range] }] } })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: (binary, uri, options) => LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    const prepared = await pool.prepareCallHierarchy(file, 0, 0)
    assert.equal(prepared.length, 2); assert.notEqual(prepared[0]!.item_id, prepared[1]!.item_id)
    const [edge] = await pool.incomingCalls(file, prepared[0]!.item_id)
    assert.equal(edge!.fromFile, caller); assert.deepEqual(edge!.fromRanges, [range, range]); assert.equal(edge!.item.file, caller)
    const [next] = await pool.outgoingCalls(file, edge!.item.item_id)
    assert.equal(next!.fromFile, caller); assert.equal(next!.item.file, callee); assert.deepEqual(next!.fromRanges, [range])
    await pool.incomingCalls(file, next!.item.item_id)
    const wire = await recordedMessages(log)
    assert.deepEqual(wire.filter(m => m.method === 'callHierarchy/incomingCalls').map(m => m.params.item), [original, outgoing])
    assert.deepEqual(wire.find(m => m.method === 'callHierarchy/outgoingCalls')!.params.item, incoming)
    await assert.rejects(pool.incomingCalls(file, 'forged'), /item.*invalid/i)
  } finally { await pool.shutdown(); await fake.dispose(); await project.dispose() }
})

test('hierarchy IDs fail across projects, synchronized changes, and crash/restart', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' }); const other = await temporaryProject({ 'source.ts': 'x' })
  const file = join(project.root, 'source.ts'); const otherFile = join(other.root, 'source.ts')
  const fake = fakeLsp({ capabilities: { callHierarchyProvider: true }, results: { 'textDocument/prepareCallHierarchy': [item(file)] } })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: (binary, uri, options) => LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    const [prepared] = await pool.prepareCallHierarchy(file, 0, 0)
    await assert.rejects(pool.incomingCalls(otherFile, prepared!.item_id), /item.*invalid/i)
    await writeFile(file, 'changed'); await assert.rejects(pool.incomingCalls(file, prepared!.item_id), /item.*invalid/i)
    const [fresh] = await pool.prepareCallHierarchy(file, 0, 0)
    const child = fake.processes[0]!; child.kill('SIGKILL'); await waitFor(() => child.exitCode !== null || child.signalCode !== null)
    await assert.rejects(pool.outgoingCalls(file, fresh!.item_id), /item.*invalid/i)
    assert.equal(fake.processes.length, 3)
  } finally { await pool.shutdown(); await fake.dispose(); await Promise.all([project.dispose(), other.dispose()]) }
})

for (const invalid of [null, [{ from: {}, fromRanges: [range] }], [{ from: item('/tmp/a.ts'), fromRanges: [range] }, { from: item('/tmp/a.ts'), fromRanges: [{}] }]]) {
  test(`hierarchy ${invalid === null ? 'unsupported capability' : 'partial corrupt edges'} rejects`, async () => {
    const project = await temporaryProject({ 'source.ts': 'x' }); const file = join(project.root, 'source.ts')
    const fake = fakeLsp({ capabilities: { callHierarchyProvider: invalid !== null }, results: { 'textDocument/prepareCallHierarchy': [item(file)], 'callHierarchy/incomingCalls': invalid } })
    const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
    try {
      if (invalid === null) await assert.rejects(client.prepareCallHierarchy(file, 0, 0), /capability/)
      else { const [prepared] = await client.prepareCallHierarchy(file, 0, 0); await assert.rejects(client.incomingCalls(file, prepared!.item_id), /protocol/i) }
    } finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
  })
}

test('broad unrelated events retain IDs; synchronized files and external dependency subtree deletions expire them', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  const project = await temporaryProject({ 'project/source.ts': 'x', 'independent/source.ts': 'x', 'system/noise.log': 'x', 'deps/types.d.ts': 'declare const value: 1' })
  const root = join(project.root, 'project'); const file = join(root, 'source.ts'); const log = join(project.root, 'wire.jsonl')
  const callbacks: Array<(event: string, file: string) => void> = []
  t.mock.method(fs, 'watch', ((...args: any[]) => { callbacks.push(args.at(-1)); const handle = new EventEmitter() as EventEmitter & { close(): void }; handle.close = () => {}; return handle }) as typeof fs.watch); syncBuiltinESMExports()
  const fake = fakeLsp({ log, capabilities: { callHierarchyProvider: true }, results: { 'textDocument/prepareCallHierarchy': [item(file)] } })
  const client = await LspClient.create('fake', pathToUri(root), { spawnProcess: fake.spawnProcess })
  try {
    await client.documentSession.register({ registrations: [{ id: 'native', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: join(project.root, '**/*') }, { globPattern: join(project.root, '**/*.d.ts') }] } }] })
    const [prepared] = await client.prepareCallHierarchy(file, 0, 0)
    for (const callback of callbacks) { callback('change', 'system/noise.log'); callback('change', 'independent/source.ts'); callback('rename', 'unrelated/deleted') }
    await client.incomingCalls(file, prepared!.item_id)
    const changes = (await recordedMessages(log)).filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes)
    assert.ok(changes.some(c => c.uri.endsWith('system/noise.log'))); assert.ok(changes.some(c => c.uri.endsWith('independent/source.ts')))
    await writeFile(file, 'second'); await assert.rejects(client.incomingCalls(file, prepared!.item_id), /item.*invalid/i)
    const [fresh] = await client.prepareCallHierarchy(file, 0, 0)
    await writeFile(join(project.root, 'deps/types.d.ts'), 'declare const value: 2')
    for (const callback of callbacks) callback('change', 'deps/types.d.ts')
    await assert.rejects(client.outgoingCalls(file, fresh!.item_id), /item.*invalid/i)
    const [beforeDeletion] = await client.prepareCallHierarchy(file, 0, 0)
    await rm(join(project.root, 'deps'), { recursive: true })
    for (const callback of callbacks) callback('rename', 'deps')
    await assert.rejects(client.incomingCalls(file, beforeDeletion!.item_id), /item.*invalid/i)
  } finally { await client.shutdown(); await fake.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); await project.dispose() }
})


test('concrete registration invalidates unopened external dependency directory while broad unknown directories remain noise', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  const project = await temporaryProject({ 'project/source.ts': 'x', 'shared/deps/types.d.ts': 'declare const value: 1' })
  const root = join(project.root, 'project'); const file = join(root, 'source.ts'); const log = join(project.root, 'wire.jsonl')
  let callback!: (event: string, file: string) => void
  t.mock.method(fs, 'watch', ((...args: any[]) => { callback = args.at(-1); const handle = new EventEmitter() as EventEmitter & { close(): void }; handle.close = () => {}; return handle }) as typeof fs.watch); syncBuiltinESMExports()
  const fake = fakeLsp({ log, capabilities: { callHierarchyProvider: true }, results: { 'textDocument/prepareCallHierarchy': [item(file)] } })
  const client = await LspClient.create('fake', pathToUri(root), { spawnProcess: fake.spawnProcess })
  try {
    await client.documentSession.register({ registrations: [{ id: 'native', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: join(project.root, '**/*') }, { globPattern: join(project.root, 'shared/deps/**/*.d.ts') }] } }] })
    const [prepared] = await client.prepareCallHierarchy(file, 0, 0)
    callback('rename', 'independent/deleted'); await client.incomingCalls(file, prepared!.item_id)
    await rm(join(project.root, 'shared'), { recursive: true })
    callback('rename', 'shared')
    await assert.rejects(client.incomingCalls(file, prepared!.item_id), /item.*invalid/i)
    const wire = await recordedMessages(log)
    assert.equal(wire.filter(m => m.method === 'textDocument/didOpen').length, 1, 'dependency was never opened')
    const changes = wire.filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes)
    assert.ok(changes.some(c => c.uri.endsWith('/shared') && c.type === 3))
    assert.ok(changes.some(c => c.uri.endsWith('/independent/deleted') && c.type === 3))
  } finally { await client.shutdown(); await fake.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); await project.dispose() }
})


test('malformed prepare/outgoing items reject entire results and valid null responses remain empty', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' }); const file = join(project.root, 'source.ts')
  try {
    for (const direction of ['prepare', 'outgoing', 'empty'] as const) {
      const fake = fakeLsp({ capabilities: { callHierarchyProvider: true }, results: {
        'textDocument/prepareCallHierarchy': direction === 'prepare' ? [item(file), { ...item(file), range: {} }] : direction === 'empty' ? null : [item(file)],
        'callHierarchy/outgoingCalls': [{ to: item(file), fromRanges: [range] }, { to: { ...item(file), uri: 'https://invalid' }, fromRanges: [range] }],
      } })
      const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
      try {
        if (direction === 'prepare') await assert.rejects(client.prepareCallHierarchy(file, 0, 0), /protocol/i)
        else if (direction === 'empty') assert.deepEqual(await client.prepareCallHierarchy(file, 0, 0), [])
        else { const [node] = await client.prepareCallHierarchy(file, 0, 0); await assert.rejects(client.outgoingCalls(file, node!.item_id), /URI|protocol/i) }
      } finally { await client.shutdown(); await fake.dispose() }
    }
  } finally { await project.dispose() }
})
