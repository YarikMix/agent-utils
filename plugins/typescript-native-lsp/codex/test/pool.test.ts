import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { LspClient } from '../src/lsp-client.ts'
import { TypeScriptPool } from '../src/pool.ts'
import { fakeLsp, recordedMessages, temporaryProject, waitFor } from './support.ts'

async function fixturePool(options: Record<string, unknown> = {}, idleTimeoutMs?: number) {
  const fake = fakeLsp(options)
  const pool = new TypeScriptPool(async () => 'fixture', {
    idleTimeoutMs,
    createClient: (binary, root, options) => LspClient.create(binary, root, { ...options, spawnProcess: fake.spawnProcess, requestTimeoutMs: 500 }),
  })
  return { fake, pool, async dispose() { await pool.shutdown(); await fake.dispose() } }
}

test('same-root concurrent cold starts are deduplicated and whole operations serialized', async () => {
  const project = await temporaryProject({ 'source.ts': 'const x = 1' })
  const fixture = await fixturePool()
  const order: string[] = []
  try {
    await Promise.all([1, 2, 3].map(i => fixture.pool.withClient(join(project.root, 'source.ts'), async client => {
      order.push(`start${i}`)
      await delay(25)
      assert.equal(await client.hover(join(project.root, 'source.ts'), 0, 2), 'second')
      order.push(`end${i}`)
    })))
    const createdForSameRoot = fixture.fake.processes.length
    assert.equal(createdForSameRoot, 1)
    assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'])
  } finally { await fixture.dispose(); await project.dispose() }
})

test('nested config and no-config roots isolate clients and run independently', async () => {
  const project = await temporaryProject({ 'source.ts': '', 'nested/tsconfig.json': '{}', 'nested/source.ts': '' })
  const noConfig = await temporaryProject({ 'tsconfig.json': '', 'source.ts': '' })
  const { rm } = await import('node:fs/promises')
  await rm(join(noConfig.root, 'tsconfig.json'))
  const fixture = await fixturePool()
  try {
    await Promise.all([project.root, join(project.root, 'nested')].map(root => fixture.pool.withClient(join(root, 'source.ts'), async () => {
      await waitFor(() => fixture.fake.processes.length === 2)
    })))
    const createdForDifferentRoots = fixture.fake.processes.length
    assert.equal(createdForDifferentRoots, 2)
    await fixture.pool.withClient(join(noConfig.root, 'source.ts'), async () => {})
    assert.deepEqual(fixture.fake.roots.sort(), [project.root, join(project.root, 'nested'), noConfig.root].sort())
  } finally { await fixture.dispose(); await Promise.all([project.dispose(), noConfig.dispose()]) }
})

test('idle deadline is five minutes by default; active and queued leases survive short idle timeout', async t => {
  const project = await temporaryProject({ 'source.ts': '' })
  const fixture = await fixturePool({}, 30)
  try {
    await Promise.all([1, 2].map(() => fixture.pool.withClient(join(project.root, 'source.ts'), async client => {
      await delay(80)
      assert.equal(client.isAlive, true)
      assert.equal(fixture.fake.processes.length, 1)
    })))
    await waitFor(() => fixture.fake.processes[0]!.exitCode !== null)
    await fixture.pool.withClient(join(project.root, 'source.ts'), async () => {})
    assert.equal(fixture.fake.processes.length, 2)
    await fixture.pool.shutdown()
    const timers: number[] = []
    const original = globalThis.setTimeout
    t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, timeout?: number, ...args: any[]) => { if (timeout) timers.push(timeout); return original(callback, timeout, ...args) }) as typeof setTimeout)
    const defaults = await fixturePool()
    try {
      await defaults.pool.withClient(join(project.root, 'source.ts'), async () => {})
      const defaultIdleTimeoutMs = timers.find(timeout => timeout === 300000)
      assert.equal(defaultIdleTimeoutMs, 300000)
    } finally { await defaults.dispose() }
  } finally { await fixture.dispose(); await project.dispose() }
})

test('initialization failure and crash permit a fresh subsequent session', async () => {
  const project = await temporaryProject({ 'source.ts': '' })
  const fake = fakeLsp()
  let attempts = 0
  const pool = new TypeScriptPool(async () => 'fixture', { createClient: (binary, uri, options) => {
    if (++attempts === 1) return Promise.reject(new Error('init failed'))
    return LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess })
  } })
  try {
    await assert.rejects(pool.withClient(join(project.root, 'source.ts'), async () => {}), /init failed/)
    await pool.withClient(join(project.root, 'source.ts'), async () => {})
    fake.processes[0]!.kill('SIGKILL')
    await waitFor(() => fake.processes[0]!.signalCode !== null)
    await pool.withClient(join(project.root, 'source.ts'), async () => {})
    assert.equal(attempts, 3)
  } finally { await pool.shutdown(); await fake.dispose(); await project.dispose() }
})

test('pool shutdown also awaits a session already retiring after its idle deadline', async () => {
  const project = await temporaryProject({ 'source.ts': '' })
  const log = join(project.root, 'messages.jsonl')
  const fixture = await fixturePool({ hangShutdown: true, ignoreTerm: true, log }, 10)
  try {
    await fixture.pool.withClient(join(project.root, 'source.ts'), async () => {})
    await waitFor(async () => (await recordedMessages(log)).some(m => m.method === 'shutdown'))
    await fixture.pool.shutdown()
    assert.ok(fixture.fake.processes.every(p => p.exitCode !== null || p.signalCode !== null))
  } finally { await fixture.dispose(); await project.dispose() }
})

for (const following of ['queued operation', 'idle shutdown']) {
  test(`failed hover wrapper settles its definition before ${following}`, async () => {
    const project = await temporaryProject({ 'source.ts': 'const x = 1' })
    const log = join(project.root, 'messages.jsonl')
    const fixture = await fixturePool({ siblingFailure: true, log }, following === 'queued operation' ? 1000 : 10)
    const file = join(project.root, 'source.ts')
    const relevant = new Set(['textDocument/definition', 'fixture/definitionEnd', 'textDocument/documentSymbol', 'shutdown'])
    let definitionSettledAtRejection = false
    try {
      const hover = fixture.pool.hoverWithDefinition(file, 0, 0).catch(async error => {
        definitionSettledAtRejection = (await recordedMessages(log)).some(message => message.method === 'fixture/definitionEnd')
        throw error
      })
      const rejected = assert.rejects(hover, /fixture hover failed/)
      if (following === 'queued operation') {
        await Promise.all([rejected, fixture.pool.outline(file)])
        // Let a wrongly released sibling reach its natural deadline in RED.
        await delay(180)
        const events = (await recordedMessages(log)).filter(message => relevant.has(message.method!)).map(message => message.method)
        assert.deepEqual(events.slice(0, 3), ['textDocument/definition', 'fixture/definitionEnd', 'textDocument/documentSymbol'])
      } else {
        await rejected
        await waitFor(() => fixture.fake.processes[0]!.exitCode !== null)
        const events = (await recordedMessages(log)).filter(message => relevant.has(message.method!)).map(message => message.method)
        assert.deepEqual(events, ['textDocument/definition', 'fixture/definitionEnd', 'shutdown'])
      }
      assert.equal(definitionSettledAtRejection, true)
      assert.equal(fixture.fake.processes.length, 1)
    } finally { await fixture.dispose(); await project.dispose() }
  })
}
