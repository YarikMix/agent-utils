import assert from 'node:assert/strict'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { compileWatchPattern, createRegisteredWatcher } from '../src/watchers.ts'
import { pathToUri } from '../src/files.ts'
import { temporaryProject, waitFor } from './support.ts'

for (const kind of [1, 2, 4, 7]) {
  test(`registered watcher independently applies kind mask ${kind}`, async () => {
    const project = await temporaryProject({ 'existing.d.ts': 'declare const x: 1' })
    const changes: Array<{ file: string; type: number }> = []
    const errors: Error[] = []
    const watcher = createRegisteredWatcher(compileWatchPattern(project.root, { globPattern: { baseUri: pathToUri(project.root), pattern: '**/*.d.ts' }, kind }), (file, type) => changes.push({ file, type }), error => errors.push(error))
    try {
      await watcher.ready
      const existing = join(project.root, 'existing.d.ts'); watcher.noteFile(existing)
      if (kind === 1) {
        await writeFile(join(project.root, 'new.d.ts'), 'declare const x: 2'); await waitFor(() => changes.some(c => c.type === 1))
      } else if (kind === 4) {
        await rm(existing); await waitFor(() => changes.some(c => c.type === 3))
      } else {
        await writeFile(existing, 'declare const x: 3'); await waitFor(() => changes.some(c => c.type === 2))
      }
      assert.ok(changes.every(c => (kind & (1 << (c.type - 1))) !== 0))
      assert.equal(errors.length, 0)
    } finally { await watcher.close(); await project.dispose() }
  })
}

test('atomic replacement of a known file emits change and remains observable afterwards', async () => {
  const project = await temporaryProject({ 'source.d.ts': 'declare const x: 1' })
  const target = join(project.root, 'source.d.ts')
  const changes: number[] = []
  const watcher = createRegisteredWatcher(compileWatchPattern(project.root, { globPattern: target }), (file, type) => { if (file === target) changes.push(type) }, error => { throw error })
  try {
    await watcher.ready; watcher.noteFile(target)
    await writeFile(join(project.root, 'atomic.tmp'), 'declare const x: 2')
    await rename(join(project.root, 'atomic.tmp'), target)
    await waitFor(() => changes.includes(2)); assert.ok(!changes.includes(1))
    const previous = changes.length
    await writeFile(target, 'declare const x: 3'); await waitFor(() => changes.length > previous)
  } finally { await watcher.close(); await project.dispose() }
})

test('directory move/create and removal refresh matching descendants without crawling other roots', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const incoming = await temporaryProject({ 'nested/dep.d.ts': 'declare const x: 1' })
  const changes: Array<{ file: string; type: number }> = []
  const errors: Error[] = []
  const watcher = createRegisteredWatcher(compileWatchPattern(project.root, { globPattern: { baseUri: pathToUri(project.root), pattern: '**/*.d.ts' } }), (file, type) => changes.push({ file, type }), error => errors.push(error))
  try {
    await watcher.ready
    const arrived = join(project.root, 'arrived'); await rename(join(incoming.root, 'nested'), arrived)
    const dependency = join(arrived, 'dep.d.ts')
    await waitFor(() => changes.some(c => c.file === dependency && c.type === 1))
    await rm(arrived, { recursive: true })
    await waitFor(() => changes.some(c => c.file === dependency && c.type === 3))
    assert.equal(errors.length, 0)
  } finally { await watcher.close(); await Promise.all([project.dispose(), incoming.dispose()]) }
})

test('missing static prefix observes its later creation and ignores unrelated subtree events', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const changes: Array<{ file: string; type: number }> = []
  const errors: Error[] = []
  const watcher = createRegisteredWatcher(compileWatchPattern(project.root, { globPattern: join(project.root, 'missing/nested/**/*.d.ts') }), (file, type) => changes.push({ file, type }), error => errors.push(error))
  try {
    await watcher.ready
    await mkdir(join(project.root, 'unrelated')); await writeFile(join(project.root, 'unrelated/a.d.ts'), 'x')
    await mkdir(join(project.root, 'missing/nested'), { recursive: true })
    const file = join(project.root, 'missing/nested/b.d.ts'); await writeFile(file, 'x')
    await waitFor(() => changes.some(c => c.file === file && c.type === 1))
    assert.ok(changes.every(c => c.file.startsWith(join(project.root, 'missing'))))
    assert.equal(errors.length, 0)
    await watcher.close(); changes.length = 0
    await writeFile(file, 'changed'); assert.equal(changes.length, 0)
  } finally { await watcher.close(); await project.dispose() }
})

for (const [kind, order, expected, known] of [
  [1, ['change', 'rename'], [1], false],
  [1, ['change'], [1], false],
  [7, ['change', 'rename'], [1, 2, 2], false],
  [1, ['change'], [], true],
] as const) {
  test(`first-event classification kind=${kind} order=${order.join('→')} known=${known}`, { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
    const project = await temporaryProject({ 'source.d.ts': 'declare const x: 1' })
    const childProject = join(project.root, 'project'); await mkdir(childProject)
    let callback!: (event: string, filename: string) => void
    const handle = new EventEmitter() as EventEmitter & { close(): void }
    handle.close = () => {}
    t.mock.method(fs, 'watch', ((...args: any[]) => { callback = args[args.length - 1]; return handle }) as typeof fs.watch)
    syncBuiltinESMExports()
    const changes: number[] = []; const errors: Error[] = []
    const watcher = createRegisteredWatcher(compileWatchPattern(childProject, { globPattern: join(project.root, '**/*.d.ts'), kind }), (_file, type) => changes.push(type), error => errors.push(error))
    try {
      await watcher.ready
      if (known) watcher.noteFile(join(project.root, 'source.d.ts'))
      for (const event of order) callback(event, 'source.d.ts')
      await watcher.flush()
      assert.deepEqual(changes, expected)
      assert.equal(errors.length, 0)
      const unexpected = Object.assign(new Error('watch failure'), { code: 'UNKNOWN' })
      handle.emit('error', unexpected); assert.equal(errors[0], unexpected)
      handle.emit('error', Object.assign(new Error('protected'), { code: 'EACCES' })); assert.equal(errors.length, 1)
    } finally { await watcher.close(); t.mock.restoreAll(); syncBuiltinESMExports(); await project.dispose() }
  })
}

test('backend choice reserves native recursive watching for existing strict project ancestors', async () => {
  const project = await temporaryProject({ 'child/source.ts': 'x' })
  const outside = await temporaryProject({ 'dep.d.ts': 'x' })
  try {
    const child = join(project.root, 'child')
    const fast = ['darwin', 'win32'].includes(process.platform)
    assert.equal(compileWatchPattern(child, { globPattern: join(project.root, '**/*.ts') }).nativeRecursive, fast)
    assert.equal(compileWatchPattern(child, { globPattern: join(child, '**/*.ts') }).nativeRecursive, false)
    assert.equal(compileWatchPattern(child, { globPattern: join(outside.root, '**/*.d.ts') }).nativeRecursive, false)
    assert.equal(compileWatchPattern(child, { globPattern: join(child, 'missing/**/*.ts') }).nativeRecursive, false)
    if (fast) assert.equal(compileWatchPattern(child, { globPattern: join(child, '**/*.ts').toLowerCase() }).nativeRecursive, false)
  } finally { await Promise.all([project.dispose(), outside.dispose()]) }
})
