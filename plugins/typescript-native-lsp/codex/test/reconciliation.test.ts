import assert from 'node:assert/strict'
import { join } from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { LspClient } from '../src/lsp-client.ts'
import { TypeScriptPool } from '../src/pool.ts'
import { pathToUri } from '../src/files.ts'
import { fakeLsp, recordedMessages, temporaryProject, waitFor } from './support.ts'

async function setup(options: Record<string, unknown> = {}) {
  const project = await temporaryProject({ 'main.ts': 'export const value = 1', 'dependency.ts': 'export const dep = 1' })
  const file = join(project.root, 'main.ts'); const dependency = join(project.root, 'dependency.ts'); const log = join(project.root, 'wire.jsonl')
  const fake = fakeLsp({ ...options, log })
  const client = await LspClient.create('fake', pathToUri(project.root), { spawnProcess: fake.spawnProcess })
  await client.documentSession.sync(file)
  const session = client.documentSession as unknown as { enqueue(file: string, type: number): void }
  const enqueue = (types = [1, 2], target = dependency) => { for (const type of types) session.enqueue(target, type) }
  const messages = () => recordedMessages(log)
  const reads = async (method = 'textDocument/hover') => (await messages()).filter(m => m.method === method)
  return { project, file, dependency, client, enqueue, messages, reads, async dispose() { await client.shutdown(); await fake.dispose(); await project.dispose() } }
}
const hover = (value: string, delay = 0) => ({ result: { contents: value }, delay })

test('semantic request without events or with Create-only notification reads once and does not fabricate Changed', async () => {
  const f = await setup()
  try {
    await f.client.hover(f.file, 0, 0)
    assert.equal((await f.reads()).length, 1)
    f.enqueue([1])
    await f.client.hover(f.file, 0, 0)
    assert.equal((await f.reads()).length, 2)
    const changes = (await f.messages()).filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes)
    assert.deepEqual(changes.map(change => change.type), [1])
  } finally { await f.dispose() }
})

test('unrelated broad ambiguity adds no native read or semantic generation', async () => {
  const f = await setup(); const outside = await temporaryProject({ 'other.ts': 'x' })
  try {
    const generation = f.client.documentSession.generation
    f.enqueue([1, 2], join(outside.root, 'other.ts'))
    await f.client.hover(f.file, 0, 0)
    assert.equal((await f.reads()).length, 1)
    assert.equal(f.client.documentSession.generation, generation)
  } finally { await f.dispose(); await outside.dispose() }
})

test('ambiguous delivered events replay permitted Changed after first semantic read and return only repeated result', async () => {
  const f = await setup({ responseSequences: { 'textDocument/hover': [hover('stale'), hover('fresh')] } })
  try {
    f.enqueue()
    assert.equal(await f.client.hover(f.file, 0, 0), 'fresh')
    const wire = (await f.messages()).filter(m => ['textDocument/hover', 'workspace/didChangeWatchedFiles'].includes(m.method!))
    assert.deepEqual(wire.map(m => m.method === 'textDocument/hover' ? 'read' : m.params.changes.map((event: any) => event.type)), [[1, 2], 'read', [2], 'read'])
    await f.client.hover(f.file, 0, 0)
    assert.equal((await f.reads()).length, 3)
  } finally { await f.dispose() }
})

test('ambiguity arriving during paused native read rejects first response and is retained for next request', async () => {
  const f = await setup({ responseSequences: { 'textDocument/hover': [hover('stale', 100), hover('barrier'), hover('fresh')] } })
  try {
    const request = f.client.hover(f.file, 0, 0)
    const rejected = assert.rejects(request, /changed.*request|retry/i)
    await waitFor(async () => (await f.reads()).length === 1)
    f.enqueue()
    await rejected
    assert.equal((await f.reads()).length, 1)
    assert.equal(await f.client.hover(f.file, 0, 0), 'fresh')
    assert.equal((await f.reads()).length, 3)
  } finally { await f.dispose() }
})

test('new ambiguity during repeated read fails explicitly after at most two reads', async () => {
  const f = await setup({ responseSequences: { 'textDocument/hover': [hover('stale'), hover('also stale', 100)] } })
  try {
    f.enqueue()
    const rejected = assert.rejects(f.client.hover(f.file, 0, 0), /changed.*request|retry/i)
    await waitFor(async () => (await f.reads()).length === 2)
    f.enqueue()
    await rejected
    assert.equal((await f.reads()).length, 2)
  } finally { await f.dispose() }
})

for (const stage of ['first', 'repeat']) test(`${stage} native failure never returns stale success and retains reconciliation accounting`, async () => {
  const first = stage === 'first' ? { error: 'barrier failed' } : hover('stale')
  const f = await setup({ responseSequences: { 'textDocument/hover': [first, ...(stage === 'repeat' ? [{ error: 'repeat failed' }] : []), hover('retry barrier'), hover('fresh')] } })
  try {
    f.enqueue()
    await assert.rejects(f.client.hover(f.file, 0, 0), /failed/)
    assert.equal(await f.client.hover(f.file, 0, 0), 'fresh')
    const changes = (await f.messages()).filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes)
    assert.deepEqual(changes.map(change => change.type), [1, 2, 2])
  } finally { await f.dispose() }
})

for (const trigger of ['abort', 'timeout']) test(`reconciliation shares original ${trigger} and never grants a second full deadline`, async () => {
  const f = await setup({ responseSequences: { 'textDocument/hover': [hover('stale', 50), hover('late', 150), hover('retry barrier'), hover('fresh')] } })
  try {
    f.enqueue()
    const controller = new AbortController(); const start = performance.now()
    const rejected = assert.rejects(f.client.hover(f.file, 0, 0, { signal: controller.signal, timeoutMs: trigger === 'timeout' ? 120 : 2000 }), trigger === 'timeout' ? /timed out/ : /abort/i)
    await waitFor(async () => (await f.reads()).length === 2)
    if (trigger === 'abort') controller.abort()
    await rejected
    if (trigger === 'timeout') assert.ok(performance.now() - start < 180, 'repeat shares the original120ms budget')
    assert.equal(await f.client.hover(f.file, 0, 0), 'fresh')
    assert.equal((await f.reads()).length, 4)
    await waitFor(async () => (await f.messages()).some(m => m.method === '$/cancelRequest'))
  } finally { await f.dispose() }
})

test('parallel hover and definition share one replay and both settle inside the original project lease', async () => {
  const f = await setup({ responseSequences: { 'textDocument/hover': [hover('stale'), hover('fresh', 80)], 'textDocument/definition': [{ result: [], delay: 30 }, { result: [], delay: 50 }] } })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: async () => f.client })
  try {
    f.enqueue()
    const composite = pool.hoverWithDefinition(f.file, 0, 0)
    const after = pool.withClient(f.file, async () => {
      assert.equal((await f.reads()).length, 2)
      assert.equal((await f.reads('textDocument/definition')).length, 2)
      return 'lease released'
    })
    assert.equal((await composite).hover, 'fresh')
    assert.equal(await after, 'lease released')
    const changes = (await f.messages()).filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes)
    assert.deepEqual(changes.map(change => change.type), [1, 2, 2])
  } finally { await pool.shutdown(); await f.dispose() }
})


test('ordinary Changed arriving during a read adds no reconciliation read or new retry error', async () => {
  const f = await setup({ responseSequences: { 'textDocument/hover': [hover('ordinary result', 70)] } })
  try {
    const request = f.client.hover(f.file, 0, 0)
    await waitFor(async () => (await f.reads()).length === 1)
    f.enqueue([2])
    assert.equal(await request, 'ordinary result')
    assert.equal((await f.reads()).length, 1)
  } finally { await f.dispose() }
})


test('omitted sibling event during actual native metadata response remains available for identity reclassification', async () => {
  const outside = await temporaryProject({ 'a.ts': 'x', 'barrel.ts': 'x' })
  const metadata = [{ name: 'a', kind: 13, location: { uri: pathToUri(join(outside.root, 'a.ts')), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }]
  const f = await setup({ capabilities: { callHierarchyProvider: true }, responseSequences: { 'workspace/symbol': [{ result: metadata, delay: 80 }, { result: metadata }] } })
  try {
    const rejected = assert.rejects(f.client.prepareCallHierarchy(f.file, 0, 0), /invalid|change/i)
    await waitFor(async () => (await f.reads('workspace/symbol')).length === 1)
    f.enqueue([1, 2], join(outside.root, 'barrel.ts'))
    await rejected
    assert.equal((await f.reads('textDocument/prepareCallHierarchy')).length, 0)
    assert.deepEqual(await f.client.prepareCallHierarchy(f.file, 0, 0), [])
    assert.equal((await f.reads('workspace/symbol')).length, 3)
    const changes = (await f.messages()).filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes).filter(event => event.uri === pathToUri(join(outside.root, 'barrel.ts')))
    assert.deepEqual(changes.map(event => event.type), [1, 2, 2])
  } finally { await f.dispose(); await outside.dispose() }
})


for (const phase of ['first', 'repeat']) for (const trigger of ['timeout', 'abort']) {
  test(`${phase} post-response watcher wait honors ${trigger} before IO release and retains queued metadata events`, { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
    const p = await temporaryProject({ 'project/main.ts': 'export const value = 1', 'project/dependency.ts': 'x', 'shared/a.ts': 'x', 'shared/barrel.ts': 'x', 'noise.log': 'noise' })
    let callback!: (event: string, file: string) => void
    t.mock.method(fs, 'watch', ((...args: any[]) => { callback = args.at(-1); const handle = new EventEmitter() as EventEmitter & { close(): void }; handle.close = () => {}; return handle }) as typeof fs.watch)
    syncBuiltinESMExports()
    const file = join(p.root, 'project/main.ts'); const log = join(p.root, 'wire.jsonl'); const noise = join(p.root, 'noise.log'); const barrel = join(p.root, 'shared/barrel.ts')
    const expectedReads = phase === 'first' ? 1 : 2
    const fake = fakeLsp({ log, responseSequences: { 'textDocument/hover': [...(phase === 'repeat' ? [hover('barrier')] : []), hover('answer', 30), hover('after release')] } })
    const client = await LspClient.create('fake', pathToUri(join(p.root, 'project')), { spawnProcess: fake.spawnProcess })
    let release!: () => void; let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); const inspecting = new Promise<void>(resolve => { entered = resolve })
    const originalStat = fsp.lstat
    const session = client.documentSession as any
    const reads = async () => (await recordedMessages(log)).filter(message => message.method === 'textDocument/hover')
    try {
      await client.documentSession.sync(file)
      await client.documentSession.register({ registrations: [{ id: 'native', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: join(p.root, '**/*'), kind: 7 }] } }] })
      if (phase === 'repeat') for (const type of [1, 2]) session.enqueue(join(p.root, 'project/dependency.ts'), type)
      t.mock.method(fsp, 'lstat', (async (...args: any[]) => { if (String(args[0]) === noise) { entered(); await gate } return originalStat(...args as Parameters<typeof originalStat>) }) as typeof fsp.lstat)
      syncBuiltinESMExports()
      const controller = new AbortController(); let settled = false
      const request = client.hover(file, 0, 0, { timeoutMs: trigger === 'timeout' ? 90 : 2000, signal: controller.signal }).then(
        () => { settled = true; return 'unexpected success' },
        error => { settled = true; return String(error) },
      )
      await waitFor(async () => (await reads()).length === expectedReads)
      callback('change', 'noise.log'); await inspecting
      callback('rename', 'shared/barrel.ts')
      await delay(50)
      if (trigger === 'abort') controller.abort()
      await delay(90)
      assert.equal(settled, true, `${trigger} must settle before releasing unrelated watcher IO`)
      assert.match(await request, trigger === 'timeout' ? /timed out/ : /abort/i)
      assert.equal((await reads()).length, expectedReads)
      release()
      await waitFor(() => session.events.has(`${pathToUri(barrel)}:1`))
      // The abandoned waiter must neither issue a late RPC nor drain this unknown
      // sidecar event before native metadata can make it semantically relevant.
      assert.equal((await reads()).length, expectedReads)
      const before = client.documentSession.generation
      await client.documentSession.noteDependencyDirectories([join(p.root, 'shared/a.ts')])
      assert.ok(client.documentSession.generation > before)
      assert.equal(await client.hover(file, 0, 0), 'after release')
      assert.equal((await reads()).length, expectedReads + 2)
      const changes = (await recordedMessages(log)).filter(message => message.method === 'workspace/didChangeWatchedFiles').flatMap(message => message.params.changes)
      assert.deepEqual(changes.filter(event => event.uri === pathToUri(barrel)).map(event => event.type), [1, 2, 2])
      if (phase === 'repeat') assert.deepEqual(changes.filter(event => event.uri === pathToUri(join(p.root, 'project/dependency.ts'))).map(event => event.type), [1, 2, 2])
      assert.equal((client as any).pending.size, 0)
    } finally { release(); await client.shutdown(); await fake.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); await p.dispose() }
  })
}
