import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { DocumentSession } from '../src/documents.ts'
import { pathToUri } from '../src/files.ts'
import { temporaryProject, waitFor } from './support.ts'

async function waitForChanges(session: DocumentSession, messages: any[], expected: Array<[string, number]>): Promise<void> {
  await waitFor(async () => {
    await session.flushFileEvents()
    return expected.every(([file, type]) => messages.some(m => m.params.changes?.some((c: any) => c.uri === pathToUri(file) && c.type === type)))
  })
}

test('deleted opened dependency closes, removes version and emits deletion before next query', async () => {
  const project = await temporaryProject({ 'source.ts': "import { x } from './dep'", 'dep.ts': 'export const x = 1' })
  const messages: Array<{ method: string; params: any }> = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  try {
    const dependency = join(project.root, 'dep.ts'); const uri = pathToUri(dependency)
    await session.sync(dependency); await rm(dependency); await session.sync(join(project.root, 'source.ts'))
    messages.push({ method: 'query', params: {} })
    assert.equal(session.getVersion(uri), undefined)
    assert.ok(messages.some(m => m.method === 'textDocument/didClose' && m.params.textDocument.uri === uri))
    const event = messages.findIndex(m => m.method === 'workspace/didChangeWatchedFiles' && m.params.changes.some((c: any) => c.uri === uri && c.type === 3))
    assert.ok(event >= 0 && event < messages.findIndex(m => m.method === 'query'))
    await assert.rejects(session.sync(dependency), /ENOENT/)
  } finally { await session.close(); await project.dispose() }
})

test('changed content versions increase and incremental sync replaces actual old range', async () => {
  const project = await temporaryProject({ 'source.ts': '😀x\r\n' })
  const messages: any[] = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  session.setSyncKind({ openClose: true, change: 2 })
  try {
    const file = join(project.root, 'source.ts'); await session.sync(file)
    await writeFile(file, 'second'); await session.sync(file)
    await writeFile(file, 'third'); await session.sync(file)
    const changes = messages.filter(m => m.method === 'textDocument/didChange')
    assert.deepEqual(changes.map(m => m.params.textDocument.version), [2, 3])
    assert.deepEqual(changes[0].params.contentChanges[0].range.end, { line: 1, character: 0 })
    assert.ok(session.generation >= 3)
  } finally { await session.close(); await project.dispose() }
})

test('bootstrap source/config create and delete events flush before a request', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const messages: any[] = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  try {
    await session.flushFileEvents()
    await writeFile(join(project.root, 'created.ts'), 'x')
    await writeFile(join(project.root, 'tsconfig.json'), '{"compilerOptions":{}}')
    await waitForChanges(session, messages, [[join(project.root, 'created.ts'), 1], [join(project.root, 'tsconfig.json'), 2]])
    assert.ok(messages.some(m => m.params.changes?.some((c: any) => c.uri === pathToUri(join(project.root, 'created.ts')) && c.type === 1)))
    assert.ok(messages.some(m => m.params.changes?.some((c: any) => c.uri.endsWith('tsconfig.json') && c.type === 2)))
    await rm(join(project.root, 'created.ts'))
    await waitForChanges(session, messages, [[join(project.root, 'created.ts'), 3]])
  } finally { await session.close(); await project.dispose() }
})

test('registered RelativePattern watches node_modules and external declarations with watch-kind and unregister', async () => {
  const project = await temporaryProject({ 'source.ts': 'x', 'node_modules/pkg/index.d.ts': 'export const x: 1' })
  const outside = await temporaryProject({ 'stdlib.d.ts': 'declare const x: 1' })
  const messages: any[] = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  try {
    await session.register({ registrations: [{ id: 'deps', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [
      { globPattern: { baseUri: { uri: pathToUri(project.root), name: 'project' }, pattern: 'node_modules/**/*.d.ts' }, kind: 2 },
      { globPattern: pathToUri(join(outside.root, '*.d.ts')), kind: 2 },
    ] } }] })
    await session.flushFileEvents()
    await writeFile(join(project.root, 'node_modules/pkg/index.d.ts'), 'export const x: 2')
    await writeFile(join(outside.root, 'stdlib.d.ts'), 'declare const x: 2')
    await waitForChanges(session, messages, [[join(project.root, 'node_modules/pkg/index.d.ts'), 2], [join(outside.root, 'stdlib.d.ts'), 2]])
    const changed = messages.flatMap(m => m.params.changes ?? []).filter(c => c.type === 2)
    assert.ok(changed.some(c => c.uri.includes('node_modules')))
    assert.ok(changed.some(c => c.uri === pathToUri(join(outside.root, 'stdlib.d.ts'))))
    messages.length = 0
    await rm(join(project.root, 'node_modules/pkg/index.d.ts'))
    await session.flushFileEvents(); assert.equal(messages.length, 0)
    await session.unregister({ unregisterations: [{ id: 'deps', method: 'workspace/didChangeWatchedFiles' }] })
    await assert.rejects(session.register({ registrations: [{ id: 'bad', method: 'workspace/unsupported' }] }), /unsupported/i)
    await assert.rejects(session.register({ registrations: [{ id: 'bad', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: 4 }] } }] }), /watch|pattern|registration/i)
  } finally { await session.close(); await Promise.all([project.dispose(), outside.dispose()]) }
})

test('permission errors reading an opened dependency propagate rather than becoming deletion', { skip: process.platform === 'win32' }, async () => {
  const { chmod } = await import('node:fs/promises')
  const project = await temporaryProject({ 'source.ts': 'x', 'dep.ts': 'x' })
  const messages: any[] = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  const dependency = join(project.root, 'dep.ts')
  try {
    await session.sync(dependency); await chmod(dependency, 0)
    await assert.rejects(session.sync(join(project.root, 'source.ts')), { code: 'EACCES' })
    assert.equal(session.getVersion(pathToUri(dependency)), 1)
    assert.equal(messages.filter(m => m.method === 'textDocument/didClose').length, 0)
  } finally { await chmod(dependency, 0o600); await session.close(); await project.dispose() }
})

test('shutdown during pending watcher registration settles and closes every owned watcher', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const session = new DocumentSession(project.root, () => {})
  try {
    const pending = session.register({ registrations: [{ id: 'pending', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: { baseUri: pathToUri(project.root), pattern: '**/*.ts' } }] } }] })
    const settled = pending.then(() => 'resolved', () => 'rejected')
    await session.close()
    const { setTimeout: delay } = await import('node:timers/promises')
    assert.equal(await Promise.race([settled, delay(500, 'timeout')]), 'rejected')
    await assert.rejects(session.register({ registrations: [] }), /closed/)
  } finally { await session.close(); await project.dispose() }
})

test('leased parallel operations preserve strictly increasing sync-before-query versions', async () => {
  const { LspClient } = await import('../src/lsp-client.ts')
  const { TypeScriptPool } = await import('../src/pool.ts')
  const { fakeLsp, recordedMessages } = await import('./support.ts')
  const project = await temporaryProject({ 'source.ts': 'initial' })
  const file = join(project.root, 'source.ts'); const log = join(project.root, 'messages.jsonl')
  const fake = fakeLsp({ log })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: (binary, uri, options) => LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    await pool.withClient(file, client => client.hover(file, 0, 0))
    await Promise.all(['second', 'third'].map(content => pool.withClient(file, async client => {
      await writeFile(file, content)
      return client.hover(file, 0, 0)
    })))
    const messages = (await recordedMessages(log)).filter(m => ['textDocument/didChange', 'textDocument/hover'].includes(m.method!))
    assert.deepEqual(messages.filter(m => m.method === 'textDocument/didChange').map(m => m.params.textDocument.version), [2, 3])
    assert.deepEqual(messages.map(m => m.method), ['textDocument/hover', 'textDocument/didChange', 'textDocument/hover', 'textDocument/didChange', 'textDocument/hover'])
  } finally { await pool.shutdown(); await fake.dispose(); await project.dispose() }
})

test('hover and definition siblings share one document snapshot during external change', async () => {
  const { LspClient } = await import('../src/lsp-client.ts')
  const { TypeScriptPool } = await import('../src/pool.ts')
  const { fakeLsp, recordedMessages } = await import('./support.ts')
  const project = await temporaryProject({ 'source.ts': 'initial' })
  const file = join(project.root, 'source.ts'); const log = join(project.root, 'messages.jsonl')
  const fake = fakeLsp({ log })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: async (binary, uri, options) => {
    const client = await LspClient.create(binary, uri, { ...options, spawnProcess: fake.spawnProcess })
    const hover = client.hover.bind(client)
    client.hover = async (...args) => { await writeFile(file, 'external'); return hover(...args) }
    return client
  } })
  try {
    await pool.hoverWithDefinition(file, 0, 0)
    assert.equal((await recordedMessages(log)).filter(m => m.method === 'textDocument/didChange').length, 0)
    await pool.references(file, 0, 0)
    const messages = await recordedMessages(log)
    assert.equal(messages.filter(m => m.method === 'textDocument/didChange').length, 1)
    assert.equal(messages.find(m => m.method === 'textDocument/references')!.params.context.includeDeclaration, true)
  } finally { await pool.shutdown(); await fake.dispose(); await project.dispose() }
})

test('registered readonly watchers skip inaccessible directories and still deliver accessible dependency changes', { skip: process.platform === 'win32' }, async () => {
  const { chmod, mkdir } = await import('node:fs/promises')
  const project = await temporaryProject({ 'source.ts': 'x' })
  const outside = await temporaryProject({ 'dep.d.ts': 'declare const x: 1' })
  const protectedDirectory = join(outside.root, 'protected'); await mkdir(protectedDirectory)
  await chmod(protectedDirectory, 0)
  const messages: any[] = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  try {
    await session.register({ registrations: [{ id: 'readonly', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: { baseUri: pathToUri(outside.root), pattern: '**/*' } }] } }] })
    await writeFile(join(outside.root, 'dep.d.ts'), 'declare const x: 2')
    await waitForChanges(session, messages, [[join(outside.root, 'dep.d.ts'), 2]])
    assert.ok(messages.some(m => m.params.changes?.some((c: any) => c.uri === pathToUri(join(outside.root, 'dep.d.ts')) && c.type === 2)))
    await session.unregister({ unregisterations: [{ id: 'readonly', method: 'workspace/didChangeWatchedFiles' }] })
  } finally { await chmod(protectedDirectory, 0o700); await session.close(); await Promise.all([project.dispose(), outside.dispose()]) }
})

test('native case-normalized registration observes actual-case file on darwin and win32', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const outside = await temporaryProject({ 'CaseFolder/Types.d.ts': 'declare const x: 1' })
  const messages: any[] = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  try {
    const lowerPattern = join(outside.root, 'CaseFolder', '**/*.d.ts').toLowerCase()
    await session.register({ registrations: [{ id: 'case', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: lowerPattern, kind: 2 }] } }] })
    await writeFile(join(outside.root, 'CaseFolder/Types.d.ts'), 'declare const x: 2')
    await waitForChanges(session, messages, [[join(outside.root, 'CaseFolder/Types.d.ts'), 2]])
    assert.ok(messages.some(m => m.params.changes?.some((c: any) => c.uri === pathToUri(join(outside.root, 'CaseFolder/Types.d.ts')) && c.type === 2)))
  } finally { await session.close(); await Promise.all([project.dispose(), outside.dispose()]) }
})

test('registered file watchers skip unix sockets while observing regular files', { skip: process.platform === 'win32' }, async () => {
  const { createServer } = await import('node:net')
  const project = await temporaryProject({ 'source.ts': 'x' })
  const outside = await temporaryProject({ 'dep.d.ts': 'declare const x: 1' })
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(join(outside.root, 'socket'), resolve) })
  const messages: any[] = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  try {
    await session.register({ registrations: [{ id: 'files', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: { baseUri: pathToUri(outside.root), pattern: '**/*' } }] } }] })
    await writeFile(join(outside.root, 'dep.d.ts'), 'declare const x: 2')
    await waitForChanges(session, messages, [[join(outside.root, 'dep.d.ts'), 2]])
  } finally { await session.close(); await new Promise<void>(resolve => socket.close(() => resolve())); await Promise.all([project.dispose(), outside.dispose()]) }
})

test('server shutdown may unregister a known registration after local watchers already closed', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' })
  const session = new DocumentSession(project.root, () => {})
  try {
    await session.register({ registrations: [{ id: 'shutdown', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: { baseUri: pathToUri(project.root), pattern: '**/*.ts' } }] } }] })
    await session.close()
    await session.unregister({ unregisterations: [{ id: 'shutdown', method: 'workspace/didChangeWatchedFiles' }] })
  } finally { await session.close(); await project.dispose() }
})


test('external concrete declaration edits and config edits raise semantic generation without opening dependencies', async () => {
  const project = await temporaryProject({ 'source.ts': 'x' }); const outside = await temporaryProject({ 'dep.d.ts': 'declare const x: 1' })
  const messages: any[] = []; const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  try {
    await session.register({ registrations: [{ id: 'dependency', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: join(outside.root, '*.d.ts') }] } }] })
    await session.sync(join(project.root, 'source.ts')); const initial = session.generation
    await writeFile(join(outside.root, 'dep.d.ts'), 'declare const x: 2')
    await waitForChanges(session, messages, [[join(outside.root, 'dep.d.ts'), 2]])
    assert.ok(session.generation > initial); assert.equal(session.getVersion(pathToUri(join(outside.root, 'dep.d.ts'))), undefined)
    const changedDependency = session.generation
    await writeFile(join(project.root, 'tsconfig.json'), '{"compilerOptions":{"strict":false}}')
    await waitForChanges(session, messages, [[join(project.root, 'tsconfig.json'), 2]])
    assert.ok(session.generation > changedDependency)
  } finally { await session.close(); await Promise.all([project.dispose(), outside.dispose()]) }
})

test('opened enumeration copies content and current synchronized physical identity without lending versions', async () => {
  const { realpath, symlink } = await import('node:fs/promises')
  const project = await temporaryProject({ 'one.ts': 'same', 'two.ts': 'same' })
  const messages: Array<{ method: string; params: any }> = []
  const session = new DocumentSession(project.root, (method, params) => messages.push({ method, params }))
  const alias = join(project.root, 'alias.ts'); const first = join(project.root, 'one.ts'); const second = join(project.root, 'two.ts')
  try {
    await symlink(first, alias); await session.sync(alias)
    const snapshots = session.getOpenedDocuments()
    assert.deepEqual(snapshots, [{ uri: pathToUri(alias), content: 'same', physicalPath: await realpath(first) }])
    Reflect.set(snapshots[0]!, 'content', 'corrupt')
    assert.equal(session.getText(pathToUri(alias)), 'same')
    const generation = session.generation
    await rm(alias); await symlink(second, alias); await session.sync(alias)
    assert.equal(session.getOpenedDocuments()[0]!.physicalPath, await realpath(second))
    assert.equal(snapshots[0]!.physicalPath, await realpath(first))
    assert.equal(session.getVersion(pathToUri(alias)), 2)
    assert.ok(session.generation > generation)
    assert.deepEqual(messages.find(message => message.method === 'textDocument/didChange')?.params, { textDocument: { uri: pathToUri(alias), version: 2 }, contentChanges: [{ text: 'same' }] })
    assert.equal(session.getVersion(pathToUri(second)), undefined)
  } finally { await session.close(); await project.dispose() }
})
