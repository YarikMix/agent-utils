import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { LspClient } from '../src/lsp-client.ts'
import { fakeLsp, recordedMessages, temporaryProject, waitFor } from './support.ts'

for (const framing of ['split', 'coalesced', 'contentType']) {
  test(`${framing} Content-Length frames preserve Unicode byte lengths and UTF-16 handshake`, async () => {
    const project = await temporaryProject({ 'source.ts': 'const привет = "😀"' })
    const log = join(project.root, 'messages.jsonl')
    const fake = fakeLsp({ [framing]: true, log })
    try {
      const client = await LspClient.create('fixture', pathToFileURL(project.root).href, { spawnProcess: fake.spawnProcess, requestTimeoutMs: 500 })
      try {
        assert.equal(await client.hover(join(project.root, 'source.ts'), 0, 0), 'Привет 😀')
        assert.deepEqual(fake.roots, [project.root])
        const init = (await recordedMessages(log)).find(m => m.method === 'initialize')!
        assert.equal(init.params.rootUri, pathToFileURL(project.root).href)
        assert.deepEqual(init.params.capabilities.general.positionEncodings, ['utf-16'])
      } finally { await client.shutdown() }
    } finally { await fake.dispose(); await project.dispose() }
  })
}

for (const trigger of ['timeout', 'abort']) {
  test(`${trigger} removes pending request, sends cancel and ignores its late response`, async () => {
    const project = await temporaryProject({ 'source.ts': 'const x = 1' })
    const log = join(project.root, 'messages.jsonl')
    const fake = fakeLsp({ delayFirst: 150, log })
    try {
      const client = await LspClient.create('fixture', pathToFileURL(project.root).href, { spawnProcess: fake.spawnProcess })
      try {
        const controller = new AbortController()
        const first = client.hover(join(project.root, 'source.ts'), 0, 1, { timeoutMs: trigger === 'timeout' ? 40 : 1000, signal: controller.signal })
        const rejected = assert.rejects(first, trigger === 'timeout' ? /timed out/ : /abort/i)
        await waitFor(async () => (await recordedMessages(log)).some(m => m.method === 'textDocument/hover'))
        if (trigger === 'abort') controller.abort()
        await rejected
        await waitFor(async () => (await recordedMessages(log)).some(m => m.method === '$/cancelRequest'))
        const messages = await recordedMessages(log)
        const cancelledId = messages.find(m => m.method === 'textDocument/hover')!.id
        const cancelMessage = messages.find(m => m.method === '$/cancelRequest')!
        assert.equal(cancelMessage.method, '$/cancelRequest')
        assert.equal(cancelMessage.params.id, cancelledId)
        await delay(180)
        const secondResult = await client.hover(join(project.root, 'source.ts'), 0, 2)
        assert.equal(secondResult, 'second')
      } finally { await client.shutdown() }
    } finally { await fake.dispose(); await project.dispose() }
  })
}

for (const failure of ['malformed', 'badHeader', 'badEnvelope', 'largeHeader', 'crash', 'serverError']) {
  test(`transport handles ${failure} as a rejected request`, async () => {
    const project = await temporaryProject({ 'source.ts': 'const x = 1' })
    const fake = fakeLsp({ [failure]: true })
    try {
      const client = await LspClient.create('fixture', pathToFileURL(project.root).href, { spawnProcess: fake.spawnProcess, requestTimeoutMs: 500 })
      await assert.rejects(client.hover(join(project.root, 'source.ts'), 0, 0), failure === 'serverError' ? /fixture error/ : /protocol|JSON|exited|closed/i)
      await client.shutdown()
      assert.ok(fake.processes.every(p => p.exitCode !== null || p.signalCode !== null))
    } finally { await fake.dispose(); await project.dispose() }
  })
}

test('spawn error rejects create without leaving request timers', async () => {
  const project = await temporaryProject({})
  try {
    await assert.rejects(LspClient.create('/missing/compiler', pathToFileURL(project.root).href, { requestTimeoutMs: 500 }), /ENOENT|spawn/)
  } finally { await project.dispose() }
})

test('noisy stderr is drained and logging remains bounded', async t => {
  const project = await temporaryProject({ 'source.ts': 'const x = 1' })
  const fake = fakeLsp({ noise: true })
  let bytesLogged = 0
  t.mock.method(console, 'error', (...args: unknown[]) => { bytesLogged += args.map(String).join(' ').length })
  try {
    const client = await LspClient.create('fixture', pathToFileURL(project.root).href, { spawnProcess: fake.spawnProcess, requestTimeoutMs: 1000 })
    assert.equal(await client.hover(join(project.root, 'source.ts'), 0, 0), 'Привет 😀')
    await client.shutdown()
    assert.ok(bytesLogged <= 9000)
  } finally { await fake.dispose(); await project.dispose() }
})

test('explicit incompatible position encoding rejects initialization and reaps the child', async () => {
  const project = await temporaryProject({})
  const fake = fakeLsp({ encoding: 'utf-8' })
  try {
    await assert.rejects(LspClient.create('fixture', pathToFileURL(project.root).href, { spawnProcess: fake.spawnProcess, requestTimeoutMs: 500 }), /encoding.*utf-8/i)
    assert.ok(fake.processes.every(p => p.exitCode !== null || p.signalCode !== null))
  } finally { await fake.dispose(); await project.dispose() }
})

test('outgoing writes wait for backpressure before accepting more frames', async () => {
  const project = await temporaryProject({ 'source.ts': 'x'.repeat(2 * 1024 * 1024) })
  const fake = fakeLsp()
  let blockedWrites = 0
  let pendingWrites = 0
  let maxPendingWrites = 0
  try {
    const client = await LspClient.create('fixture', pathToFileURL(project.root).href, { spawnProcess(binary, root) {
      const child = fake.spawnProcess(binary, root)
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = ((...args: any[]) => {
        pendingWrites++
        maxPendingWrites = Math.max(maxPendingWrites, pendingWrites)
        const callback = args.pop() as (error?: Error | null) => void
        const accepted = (write as any)(...args, (error?: Error | null) => {
          setTimeout(() => { pendingWrites--; callback(error) }, 15)
        })
        if (!accepted) blockedWrites++
        return accepted
      }) as typeof child.stdin.write
      return child
    } })
    assert.equal(await client.hover(join(project.root, 'source.ts'), 0, 0), 'Привет 😀')
    assert.ok(blockedWrites > 0)
    assert.equal(maxPendingWrites, 1)
    await client.shutdown()
  } finally { await fake.dispose(); await project.dispose() }
})

test('native spawning uses project cwd and exact native LSP flags', async t => {
  const project = await temporaryProject({})
  const spawn = childProcess.spawn
  const calls: Parameters<typeof spawn>[] = []
  t.mock.method(console, 'error', () => {})
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => { calls.push(args); return spawn(...args) })
  syncBuiltinESMExports()
  try {
    await assert.rejects(LspClient.create(process.execPath, pathToFileURL(project.root).href, { requestTimeoutMs: 500 }), /exited|closed/)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]![1], ['--lsp', '--stdio'])
    assert.equal(calls[0]![2]!.cwd, project.root)
    assert.ok(!calls[0]![2]!.shell)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await project.dispose() }
})
