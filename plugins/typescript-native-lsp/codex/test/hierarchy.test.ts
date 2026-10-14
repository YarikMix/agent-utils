import assert from 'node:assert/strict'
import { writeFile, rm, symlink } from 'node:fs/promises'
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

test('hierarchy selector accepts another unchanged project file without opening it and preserves explicit errors', async () => {
  const project = await temporaryProject({ 'source.ts': 'x', 'other.ts': 'x' })
  const file = join(project.root, 'source.ts'); const other = join(project.root, 'other.ts'); const missing = join(project.root, 'missing.ts'); const log = join(project.root, 'wire.jsonl')
  const fake = fakeLsp({ log, capabilities: { callHierarchyProvider: true }, results: { 'textDocument/prepareCallHierarchy': [item(file)] } })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: (binary, uri, options) => LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    const [prepared] = await pool.prepareCallHierarchy(file, 0, 0)
    for (const call of [pool.incomingCalls.bind(pool), pool.outgoingCalls.bind(pool)]) {
      await assert.rejects(call(missing, prepared!.item_id), { code: 'ENOENT' })
      await assert.rejects(async () => call('relative.ts', prepared!.item_id), /absolute/i)
      assert.deepEqual(await call(other, prepared!.item_id), [])
    }
    assert.equal(fake.processes.length, 1)
    assert.deepEqual((await recordedMessages(log)).filter(m => m.method === 'textDocument/didOpen').map(m => m.params.textDocument.uri), [pathToUri(file)])
    await writeFile(file, 'changed')
    await assert.rejects(pool.incomingCalls(other, prepared!.item_id), /item.*invalid/i)
  } finally { await pool.shutdown(); await fake.dispose(); await project.dispose() }
})

for (const direction of ['prepare', 'incoming', 'outgoing'] as const) {
  for (const result of [null, []]) {
    for (const changed of [false, true]) {
      test(`${direction} empty ${result === null ? 'null' : 'array'} response ${changed ? 'rejects relevant concurrent event' : 'succeeds without change'}`, async t => {
        const project = await temporaryProject({ 'source.ts': 'x' }); const file = join(project.root, 'source.ts')
        const method = direction === 'prepare' ? 'textDocument/prepareCallHierarchy' : `callHierarchy/${direction}Calls`
        const fake = fakeLsp({ capabilities: { callHierarchyProvider: true }, results: { 'textDocument/prepareCallHierarchy': [item(file)], [method]: result } })
        const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
        try {
          const node = direction === 'prepare' ? undefined : (await client.prepareCallHierarchy(file, 0, 0))[0]!
          // Inject the same relevant watcher event at the response boundary for both empty forms.
          const transport = client as unknown as { sendRequest(method: string, params: unknown, options?: import('../src/lsp-client.ts').RequestOptions): Promise<unknown> }
          const send = transport.sendRequest.bind(client)
          t.mock.method(transport, 'sendRequest', async (...args: Parameters<typeof send>) => {
            const response = await send(...args)
            if (changed && args[0] === method) (client.documentSession as unknown as { enqueue(file: string, type: number): void }).enqueue(file, 2)
            return response
          })
          const operation = direction === 'prepare' ? client.prepareCallHierarchy(file, 0, 0) : direction === 'incoming' ? client.incomingCalls(file, node!.item_id) : client.outgoingCalls(file, node!.item_id)
          if (changed) await assert.rejects(operation, /item.*invalid/i)
          else assert.deepEqual(await operation, [])
        } finally { t.mock.restoreAll(); await client.shutdown(); await fake.dispose(); await project.dispose() }
      })
    }
  }
}

test('hierarchy indexes native dependency identities once per generation and subset searches retain them', async t => {
  const project = await temporaryProject({ 'source.ts': 'x' }); const outside = await temporaryProject({ 'shared/types.d.ts': 'declare const value: 1' })
  const file = join(project.root, 'source.ts'); const dependency = join(outside.root, 'shared/types.d.ts'); const log = join(project.root, 'wire.jsonl')
  const fake = fakeLsp({ log, capabilities: { callHierarchyProvider: true, workspaceSymbolProvider: true }, results: {
    'workspace/symbol': [{ name: 'value', kind: 13, location: { uri: pathToUri(dependency), range } }],
    'textDocument/prepareCallHierarchy': [item(file)],
  } })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  const session = client.documentSession as unknown as { enqueue(file: string, type: number): void }
  try {
    const [first] = await client.prepareCallHierarchy(file, 0, 0)
    await client.prepareCallHierarchy(file, 0, 0)
    assert.equal((await recordedMessages(log)).filter(m => m.method === 'workspace/symbol' && m.params.query === '').length, 1)
    const raw = client as unknown as { sendRequest(method: string, params: { query?: string }, options?: import('../src/lsp-client.ts').RequestOptions): Promise<unknown> }
    const send = raw.sendRequest.bind(client)
    t.mock.method(raw, 'sendRequest', async (...args: Parameters<typeof send>) => {
      const result = await send(...args)
      return args[0] === 'workspace/symbol' && args[1].query === 'subset' ? [] : result
    })
    assert.deepEqual(await client.workspaceSymbols(file, 'subset'), [])
    session.enqueue(join(outside.root, 'independent.ts'), 2)
    await client.incomingCalls(file, first!.item_id)
    session.enqueue(dependency, 2)
    await assert.rejects(client.incomingCalls(file, first!.item_id), /invalid|expired/)
    const [second] = await client.prepareCallHierarchy(file, 0, 0)
    assert.equal((await recordedMessages(log)).filter(m => m.method === 'workspace/symbol' && m.params.query === '').length, 2)
    session.enqueue(join(outside.root, 'shared'), 3)
    await assert.rejects(client.incomingCalls(file, second!.item_id), /invalid|expired/)
    assert.equal(client.documentSession.getVersion(pathToUri(dependency)), undefined)
  } finally { await client.shutdown(); await fake.dispose(); await Promise.all([project.dispose(), outside.dispose()]) }
})

for (const metadata of ['unsupported', 'malformed', 'concurrent'] as const) {
  test(`hierarchy dependency metadata ${metadata} fails explicitly before returning an ID`, async t => {
    const project = await temporaryProject({ 'source.ts': 'x' }); const outside = await temporaryProject({ 'dep.d.ts': 'x' })
    const file = join(project.root, 'source.ts'); const dependency = join(outside.root, 'dep.d.ts')
    const fake = fakeLsp({ capabilities: { callHierarchyProvider: true, workspaceSymbolProvider: metadata !== 'unsupported' }, results: {
      'workspace/symbol': metadata === 'malformed' ? [{ name: 'broken', location: {} }] : [{ name: 'value', kind: 13, location: { uri: pathToUri(dependency), range } }],
      'textDocument/prepareCallHierarchy': [item(file)],
    } })
    const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
    try {
      if (metadata === 'concurrent') {
        const raw = client as any
        const send = raw.sendRequest.bind(client)
        t.mock.method(raw, 'sendRequest', async (...args: any[]) => {
          const result = await send(...args)
          if (args[0] === 'workspace/symbol') (client.documentSession as any).enqueue(dependency, 2)
          return result
        })
      }
      await assert.rejects(client.prepareCallHierarchy(file, 0, 0), metadata === 'unsupported' ? /capability/ : metadata === 'malformed' ? /protocol/ : /invalid|change/)
    } finally { await client.shutdown(); await fake.dispose(); await Promise.all([project.dispose(), outside.dispose()]) }
  })
}

test('late native registrations inherit known dependency identities instead of reporting an existing file as newly created', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  const p = await temporaryProject({ 'project/source.ts': 'x', 'shared/dependency.ts': 'x' })
  const file = join(p.root, 'project/source.ts'); const dependency = join(p.root, 'shared/dependency.ts'); const log = join(p.root, 'wire.jsonl')
  let callback!: (event: string, file: string) => void
  t.mock.method(fs, 'watch', ((...args: any[]) => { callback = args.at(-1); const handle = new EventEmitter() as EventEmitter & { close(): void }; handle.close = () => {}; return handle }) as typeof fs.watch); syncBuiltinESMExports()
  const fake = fakeLsp({ log })
  const client = await LspClient.create('fake', pathToUri(join(p.root, 'project')), { spawnProcess: fake.spawnProcess })
  try {
    client.documentSession.noteDependencies([dependency])
    await client.documentSession.register({ registrations: [{ id: 'late', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: join(p.root, '**/*') }] } }] })
    callback('change', 'shared/dependency.ts')
    await client.hover(file, 0, 0)
    const changes = (await recordedMessages(log)).filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes)
    assert.deepEqual(changes.filter(change => change.uri === pathToUri(dependency)), [{ uri: pathToUri(dependency), type: 2 }])
  } finally { await client.shutdown(); await fake.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); await p.dispose() }
})


test('native-used dependency parents cover only immediate regular source/config siblings', async () => {
  const project = await temporaryProject({ 'main.ts': 'x' })
  const outside = await temporaryProject({ 'shared/a.ts': 'x', 'shared/barrel.ts': 'x', 'shared/package.json': '{}', 'shared/tsconfig.build.json': '{}', 'shared/trace.log': 'x', 'shared/trace.json': '{}', 'shared/nested/barrel.ts': 'x', 'other/barrel.ts': 'x' })
  const file = join(project.root, 'main.ts'); const dependency = join(outside.root, 'shared/a.ts')
  const fake = fakeLsp({ capabilities: { callHierarchyProvider: true }, results: { 'workspace/symbol': [{ name: 'a', kind: 13, location: { uri: pathToUri(dependency), range } }], 'textDocument/prepareCallHierarchy': [item(file)] } })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  const session = client.documentSession as unknown as { enqueue(file: string, type: number): void }
  try {
    if (process.platform !== 'win32') await symlink(join(outside.root, 'shared/a.ts'), join(outside.root, 'shared/alias.ts'))
    const [node] = await client.prepareCallHierarchy(file, 0, 0)
    for (const name of ['shared/trace.log', 'shared/trace.json', 'shared/nested/barrel.ts', 'other/barrel.ts', ...(process.platform !== 'win32' ? ['shared/alias.ts'] : [])]) session.enqueue(join(outside.root, name), 2)
    await client.incomingCalls(file, node!.item_id)
    for (const name of ['shared/barrel.ts', 'shared/package.json', 'shared/tsconfig.build.json']) {
      const [current] = await client.prepareCallHierarchy(file, 0, 0)
      session.enqueue(join(outside.root, name), 2)
      await assert.rejects(client.incomingCalls(file, current!.item_id), /invalid|expired/)
    }
    assert.equal(client.documentSession.getOpenedDocuments().length, 1)
  } finally { await client.shutdown(); await fake.dispose(); await Promise.all([project.dispose(), outside.dispose()]) }
})

test('omitted sibling event during native metadata cannot mint a hierarchy ID', async t => {
  const project = await temporaryProject({ 'main.ts': 'x' }); const outside = await temporaryProject({ 'a.ts': 'x', 'barrel.ts': 'x' })
  const file = join(project.root, 'main.ts')
  const fake = fakeLsp({ capabilities: { callHierarchyProvider: true }, results: { 'workspace/symbol': [{ name: 'a', kind: 13, location: { uri: pathToUri(join(outside.root, 'a.ts')), range } }], 'textDocument/prepareCallHierarchy': [item(file)] } })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  try {
    const raw = client as any; const send = raw.sendRequest.bind(client)
    t.mock.method(raw, 'sendRequest', async (...args: any[]) => {
      const result = await send(...args)
      if (args[0] === 'workspace/symbol') (client.documentSession as any).enqueue(join(outside.root, 'barrel.ts'), 2)
      return result
    })
    await assert.rejects(client.prepareCallHierarchy(file, 0, 0), /invalid|change/)
  } finally { await client.shutdown(); await fake.dispose(); await Promise.all([project.dispose(), outside.dispose()]) }
})


test('dependency directory baseline seeds late watchers but keeps new-file create masks', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  const p = await temporaryProject({ 'project/main.ts': 'x', 'shared/a.ts': 'x', 'shared/barrel.ts': 'x' })
  const file = join(p.root, 'project/main.ts'); const log = join(p.root, 'wire.jsonl')
  let callback!: (event: string, file: string) => void
  t.mock.method(fs, 'watch', ((...args: any[]) => { callback = args.at(-1); const handle = new EventEmitter() as EventEmitter & { close(): void }; handle.close = () => {}; return handle }) as typeof fs.watch); syncBuiltinESMExports()
  const fake = fakeLsp({ log, capabilities: { callHierarchyProvider: true }, results: { 'workspace/symbol': [{ name: 'a', kind: 13, location: { uri: pathToUri(join(p.root, 'shared/a.ts')), range } }], 'textDocument/prepareCallHierarchy': [item(file)] } })
  const client = await LspClient.create('fake', pathToUri(join(p.root, 'project')), { spawnProcess: fake.spawnProcess })
  try {
    await client.prepareCallHierarchy(file, 0, 0)
    await client.documentSession.register({ registrations: [{ id: 'late', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: join(p.root, '**/*'), kind: 7 }] } }] })
    callback('change', 'shared/barrel.ts')
    await writeFile(join(p.root, 'shared/new.ts'), 'x')
    callback('rename', 'shared/new.ts')
    await client.hover(file, 0, 0)
    const changes = (await recordedMessages(log)).filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes)
    assert.deepEqual(changes.filter(change => change.uri === pathToUri(join(p.root, 'shared/barrel.ts'))).map(change => change.type), [2])
    assert.deepEqual(changes.filter(change => change.uri === pathToUri(join(p.root, 'shared/new.ts'))).map(change => change.type), [1, 2])
  } finally { await client.shutdown(); await fake.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); await p.dispose() }
})


test('unavailable native dependency parent fails metadata explicitly before issuing a hierarchy ID', async () => {
  const project = await temporaryProject({ 'main.ts': 'x', 'unavailable.ts': 'regular file, not a directory' })
  const file = join(project.root, 'main.ts')
  const fake = fakeLsp({ capabilities: { callHierarchyProvider: true }, results: { 'workspace/symbol': [{ name: 'a', kind: 13, location: { uri: pathToUri(join(project.root, 'unavailable.ts/a.ts')), range } }], 'textDocument/prepareCallHierarchy': [item(file)] } })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  try { await assert.rejects(client.prepareCallHierarchy(file, 0, 0), /ENOTDIR/) }
  finally { await client.shutdown(); await fake.dispose(); await project.dispose() }
})
