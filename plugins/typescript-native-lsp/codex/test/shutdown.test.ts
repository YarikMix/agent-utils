import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { LspClient } from '../src/lsp-client.ts'
import { TypeScriptPool } from '../src/pool.ts'
import { resolveTscBinary } from '../src/resolve-binary.ts'
import { fakeLsp, nativeLifetimeProbe, openMcp, temporaryProject, waitFor } from './support.ts'

const sourceEntry = join(process.cwd(), 'src/index.ts')

test('shutdown is idempotent, bounded to two seconds and kills only owned sessions', async () => {
  const project = await temporaryProject({ 'source.ts': '', 'nested/tsconfig.json': '{}', 'nested/source.ts': '' })
  const fake = fakeLsp({ hangShutdown: true, ignoreTerm: true })
  const unrelated = spawn(process.execPath, ['-e', 'process.title = "tsc-unrelated"; setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false })
  const unrelatedClosed = new Promise<void>(resolve => unrelated.once('close', () => resolve()))
  const pool = new TypeScriptPool(async () => 'fixture', { createClient: (binary, uri, options) => LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    await Promise.all([project.root, join(project.root, 'nested')].map(root => pool.withClient(join(root, 'source.ts'), async () => {})))
    assert.equal(fake.processes.length, 2)
    const start = Date.now()
    const first = pool.shutdown()
    assert.equal(pool.shutdown(), first)
    await first
    const shutdownDurationMs = Date.now() - start
    assert.ok(shutdownDurationMs <= 2250, `shutdown took ${shutdownDurationMs} ms`)
    const remainingOwnedPids = fake.processes.filter(p => p.exitCode === null && p.signalCode === null).map(p => p.pid)
    assert.equal(remainingOwnedPids.length, 0)
    const unrelatedProcessAlive = process.kill(unrelated.pid!, 0)
    assert.equal(unrelatedProcessAlive, true)
    await assert.rejects(pool.withClient(join(project.root, 'source.ts'), async () => {}), /closed|shut down/)
  } finally { unrelated.kill('SIGKILL'); await unrelatedClosed; await fake.dispose(); await project.dispose() }
})

test('shutdown aborts pending initialize and rejects queued operations without caching the client', async () => {
  const project = await temporaryProject({ 'source.ts': '' })
  const fake = fakeLsp({ hangInitialize: true })
  const pool = new TypeScriptPool(async () => 'fixture', { createClient: (binary, uri, options) => LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    let entered = 0
    const pending = [1, 2].map(() => pool.withClient(join(project.root, 'source.ts'), async () => { entered++ }))
    const settled = Promise.all(pending.map(promise => assert.rejects(promise, /abort|closed|shut down/i)))
    await waitFor(() => fake.processes.length === 1)
    const start = Date.now()
    await pool.shutdown()
    await settled
    assert.ok(Date.now() - start <= 2250)
    assert.equal(entered, 0)
    assert.ok(fake.processes.every(p => p.exitCode !== null || p.signalCode !== null))
  } finally { await fake.dispose(); await project.dispose() }
})

for (const stage of ['version', 'initialize']) {
  test(`MCP stdin EOF during ${stage} reaps pending native PID within two seconds`, { skip: process.platform === 'win32' }, async () => {
    const project = await temporaryProject({ 'source.ts': '' })
    const pidPath = join(project.root, 'owned.pid')
    const TSC_PATH = await nativeLifetimeProbe(project.root, pidPath, stage)
    const session = await openMcp(sourceEntry, { ...process.env, TSC_PATH })
    let ownedPid: number | undefined
    const requestController = new AbortController()
    try {
      const request = session.client.callTool({ name: 'outline', arguments: { file: join(project.root, 'source.ts') } }, undefined, { signal: requestController.signal }).catch(() => undefined)
      await waitFor(async () => { try { ownedPid = Number(await readFile(pidPath, 'utf8')); return !!ownedPid } catch { return false } })
      const closed = new Promise<void>(resolve => session.process.once('close', () => resolve()))
      const start = Date.now()
      session.process.stdin.end()
      await Promise.race([closed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('EOF cleanup exceeded two seconds')), 2250); timer.unref() })])
      assert.ok(Date.now() - start <= 2250)
      assert.throws(() => process.kill(ownedPid!, 0), /ESRCH/)
      requestController.abort()
      await request
    } finally {
      requestController.abort()
      await session.close()
      if (ownedPid) { try { process.kill(ownedPid, 'SIGKILL') } catch {} }
      await project.dispose()
    }
  })
}

test('pool shutdown aborts its pending native version resolver', { skip: process.platform === 'win32' }, async () => {
  const project = await temporaryProject({ 'source.ts': '' })
  const pidPath = join(project.root, 'probe.pid')
  const TSC_PATH = await nativeLifetimeProbe(project.root, pidPath, 'version')
  const pool = new TypeScriptPool(signal => resolveTscBinary({ env: { TSC_PATH }, signal }))
  try {
    const pending = pool.withClient(join(project.root, 'source.ts'), async () => {})
    const rejected = assert.rejects(pending, /abort|closed/i)
    let pid = 0
    await waitFor(async () => { try { pid = Number(await readFile(pidPath, 'utf8')); return !!pid } catch { return false } })
    const start = Date.now()
    await pool.shutdown()
    await rejected
    assert.ok(Date.now() - start <= 2250)
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally { await pool.shutdown(); await project.dispose() }
})

test('client shutdown closes active requests without waiting for their 30-second deadline', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const log = join(project.root, 'messages.jsonl')
  await writeFile(log, '')
  const fake = fakeLsp({ delayFirst: 5000, log })
  try {
    const client = await LspClient.create('fixture', pathToFileURL(project.root).href, { spawnProcess: fake.spawnProcess })
    const request = client.hover(join(project.root, 'source.ts'), 0, 1)
    const rejected = assert.rejects(request, /shut down|closed/i)
    await waitFor(async () => (await readFile(log, 'utf8')).includes('textDocument/hover'))
    const first = client.shutdown()
    assert.equal(client.shutdown(), first)
    await first
    await rejected
  } finally { await fake.dispose(); await project.dispose() }
})
