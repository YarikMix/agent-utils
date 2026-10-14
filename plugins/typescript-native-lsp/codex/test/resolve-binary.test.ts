import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { chmod, copyFile, cp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import * as resolver from '../src/resolve-binary.ts'
import { devNativeBinary, nativeVersionProbe, temporaryProject } from './support.ts'

const native = devNativeBinary()

test('PATH absence does not fall back to the checkout compiler', async () => {
  await assert.rejects(async () => resolver.resolveTscBinary({ env: { PATH: '' } }), /PATH.*TSC_PATH/s)
})

test('npm-added local .bin is skipped in favor of the next global PATH compiler', async () => {
  const fixture = await temporaryProject({})
  try {
    const localBin = join(fixture.root, 'checkout/node_modules/.bin')
    const globalBin = join(fixture.root, 'global bin')
    await mkdir(dirname(localBin), { recursive: true })
    await cp(dirname(native), localBin, { recursive: true })
    await cp(dirname(native), globalBin, { recursive: true })
    const PATH = [localBin, globalBin].join(process.platform === 'win32' ? ';' : ':')
    assert.equal(await resolver.resolveTscBinary({ env: { PATH } }), await realpath(join(globalBin, process.platform === 'win32' ? 'tsc.exe' : 'tsc')))
    await assert.rejects(resolver.resolveTscBinary({ env: { PATH: localBin } }), /PATH.*TSC_PATH/s)
  } finally { await fixture.dispose() }
})

test('absolute explicit native binary and its symlink resolve identically', async () => {
  const fixture = await temporaryProject({})
  try {
    const link = join(fixture.root, 'compiler link')
    await symlink(native, link)
    for (const TSC_PATH of [native, link]) {
      assert.equal(await resolver.resolveTscBinary({ env: { PATH: '', TSC_PATH } }), await realpath(native))
    }
  } finally { await fixture.dispose() }
})

test('TSC_PATH rejects relative, missing, nonexecutable and wrapper paths', async () => {
  const fixture = await temporaryProject({ 'wrapper': '#!/usr/bin/env node\nconsole.log("Version 7.0.0")' })
  try {
    await assert.rejects(async () => resolver.resolveTscBinary({ env: { TSC_PATH: 'relative/tsc' } }), /absolute.*TSC_PATH|TSC_PATH.*absolute/)
    await assert.rejects(async () => resolver.resolveTscBinary({ env: { TSC_PATH: join(fixture.root, 'missing') } }), /TSC_PATH.*exist/)
    await chmod(join(fixture.root, 'wrapper'), 0o755)
    await assert.rejects(async () => resolver.resolveTscBinary({ env: { TSC_PATH: join(fixture.root, 'wrapper') } }), /TSC_PATH.*native/)
    if (process.platform !== 'win32') {
      await copyFile(native, join(fixture.root, 'nonexecutable'))
      await chmod(join(fixture.root, 'nonexecutable'), 0o644)
      await assert.rejects(async () => resolver.resolveTscBinary({ env: { TSC_PATH: join(fixture.root, 'nonexecutable') } }), /TSC_PATH.*executable/)
    }
  } finally { await fixture.dispose() }
})

test('POSIX global npm symlink discovers native package with spaces in PATH', { skip: process.platform === 'win32' }, async () => {
  const fixture = await temporaryProject({})
  try {
    const prefix = join(fixture.root, 'global prefix with spaces')
    const bin = join(prefix, 'bin')
    const packageRoot = join(prefix, 'lib/node_modules/typescript')
    const nativeRoot = join(packageRoot, 'node_modules', `@typescript/typescript-${process.platform}-${process.arch}`)
    await mkdir(bin, { recursive: true })
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    await mkdir(join(nativeRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), '{"name":"typescript"}')
    await writeFile(join(packageRoot, 'bin/tsc'), '#!/usr/bin/env node\nthrow new Error("launcher must never run")')
    await writeFile(join(nativeRoot, 'package.json'), '{"name":"native"}')
    const expected = join(nativeRoot, 'lib/tsc')
    await cp(dirname(native), join(nativeRoot, 'lib'), { recursive: true })
    await symlink('../lib/node_modules/typescript/bin/tsc', join(bin, 'tsc'))
    assert.equal(await resolver.resolveTscBinary({ env: { PATH: bin } }), await realpath(expected))
  } finally { await fixture.dispose() }
})

test('Windows npm cmd shim resolves its native package without executing the shim', async () => {
  const fixture = await temporaryProject({})
  try {
    const bin = join(fixture.root, 'npm prefix with spaces')
    const packageRoot = join(bin, 'node_modules/typescript')
    const arch = process.platform === 'win32' ? process.arch : 'x64'
    const nativeRoot = join(bin, `node_modules/@typescript/typescript-win32-${arch}`)
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    await mkdir(join(nativeRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), '{"name":"typescript"}')
    await writeFile(join(packageRoot, 'bin/tsc'), '#!/usr/bin/env node\n')
    await writeFile(join(nativeRoot, 'package.json'), '{"name":"native"}')
    const expected = join(nativeRoot, 'lib/tsc.exe')
    if (process.platform === 'win32') {
      await cp(dirname(native), join(nativeRoot, 'lib'), { recursive: true })
    } else {
      const header = Buffer.alloc(128)
      header.write('MZ'); header.writeUInt32LE(64, 60); header.write('PE\0\0', 64)
      await writeFile(expected, header)
    }
    await writeFile(join(bin, 'tsc.cmd'), '@ECHO off\nSET "dp0=%~dp0"\n"%dp0%\\node.exe" "%dp0%\\node_modules\\typescript\\bin\\tsc" %*\n')
    const options = { env: { Path: bin }, platform: 'win32' as const, arch }
    const resolved = process.platform === 'win32' ? await resolver.resolveTscBinary(options) : await resolver.discoverTscBinary(options)
    assert.equal(resolved, await realpath(expected))
  } finally { await fixture.dispose() }
})

test('Linux npm symlink fixture resolves ELF without running a foreign compiler', { skip: process.platform === 'linux' }, async () => {
  const fixture = await temporaryProject({ 'global/lib/node_modules/typescript/package.json': '{"name":"typescript"}', 'global/lib/node_modules/typescript/bin/tsc': '#!/usr/bin/env node\n', 'global/lib/node_modules/@typescript/typescript-linux-x64/package.json': '{"name":"native"}' })
  try {
    const bin = join(fixture.root, 'global/bin')
    await mkdir(bin, { recursive: true })
    const expected = join(fixture.root, 'global/lib/node_modules/@typescript/typescript-linux-x64/lib/tsc')
    await mkdir(dirname(expected), { recursive: true })
    const header = Buffer.alloc(64)
    header.set([0x7f, 0x45, 0x4c, 0x46])
    await writeFile(expected, header, { mode: 0o755 })
    await symlink('../lib/node_modules/typescript/bin/tsc', join(bin, 'tsc'))
    assert.equal(await resolver.discoverTscBinary({ env: { PATH: bin }, platform: 'linux', arch: 'x64' }), await realpath(expected))
  } finally { await fixture.dispose() }
})

test('missing native package does not execute a TS6 Node launcher', { skip: process.platform === 'win32' }, async () => {
  const fixture = await temporaryProject({ 'node_modules/typescript/package.json': '{"name":"typescript","version":"6.0.0"}', 'node_modules/typescript/bin/tsc': '#!/usr/bin/env node\nconsole.log("Version 6.0.0")' })
  try {
    await symlink('node_modules/typescript/bin/tsc', join(fixture.root, 'tsc'))
    await assert.rejects(async () => resolver.resolveTscBinary({ env: { PATH: fixture.root } }), /TypeScript.*7.*PATH.*TSC_PATH/s)
  } finally { await fixture.dispose() }
})

for (const version of ['Version 6.0.0', 'something else']) {
  test(`native version probe rejects ${version}`, { skip: process.platform === 'win32' }, async () => {
    const fixture = await temporaryProject({})
    try {
      const TSC_PATH = await nativeVersionProbe(fixture.root, version)
      await assert.rejects(async () => resolver.resolveTscBinary({ env: { TSC_PATH } }), /TypeScript.*7/)
    } finally { await fixture.dispose() }
  })
}

test('version probe runs directly with shell=false and accepts future versions', { skip: process.platform === 'win32' }, async t => {
  const fixture = await temporaryProject({})
  try {
    const TSC_PATH = await nativeVersionProbe(fixture.root, 'Version 8.0.0-dev.1')
    const spawn = childProcess.spawn
    const calls: unknown[][] = []
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => { calls.push(args); return spawn(...args) })
    syncBuiltinESMExports()
    assert.equal(await resolver.resolveTscBinary({ env: { TSC_PATH } }), await realpath(TSC_PATH))
    assert.equal(calls.length, 1)
    assert.equal((calls[0]?.[2] as { shell: boolean }).shell, false)
    assert.deepEqual(calls[0]?.[1], ['--version'])
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fixture.dispose() }
})

test('hung version probe times out and kills only its own process', { skip: process.platform === 'win32' }, async t => {
  const fixture = await temporaryProject({})
  const unrelated = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false })
  const unrelatedClosed = new Promise<void>(resolve => unrelated.once('close', () => resolve()))
  try {
    const TSC_PATH = await nativeVersionProbe(fixture.root, '', true)
    const spawn = childProcess.spawn
    let probe: ReturnType<typeof spawn> | undefined
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => { probe = spawn(...args); return probe })
    syncBuiltinESMExports()
    const start = Date.now()
    await assert.rejects(async () => resolver.resolveTscBinary({ env: { TSC_PATH }, versionTimeoutMs: 100 }), /version.*timed out/i)
    assert.ok(Date.now() - start < 2000)
    assert.ok(probe?.pid)
    assert.throws(() => process.kill(probe!.pid!, 0), /ESRCH/)
    assert.equal(process.kill(unrelated.pid!, 0), true)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); unrelated.kill('SIGKILL'); await unrelatedClosed; await fixture.dispose() }
})
