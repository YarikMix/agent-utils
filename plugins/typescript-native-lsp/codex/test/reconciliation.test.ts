import assert from 'node:assert/strict'
import { join } from 'node:path'
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
