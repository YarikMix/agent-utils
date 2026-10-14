import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { LspClient } from '../src/lsp-client.ts'
import { pathToUri } from '../src/files.ts'
import { resolveTscBinary } from '../src/resolve-binary.ts'
import { nativeSpawnRecorder, nativeTestEnv, openMcp, temporaryProject } from './support.ts'
import type { CallEdge, HierarchyNode } from '../src/hierarchy.ts'
import type { LspLocation, WorkspaceSymbol } from '../src/protocol.ts'

const prefix = process.env.NATIVE_TEST_PREFIX
assert.ok(prefix, 'Use npm run test:live for an isolated pinned global compiler')
const env = await nativeTestEnv(prefix)
const binary = await resolveTscBinary({ env })
const bundle = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const artifactRoot = process.env.NATIVE_TEST_ARTIFACTS!
const fixtureUrl = new URL('./fixtures/project/', import.meta.url)
const expectedTools = ['hover', 'diagnostics', 'references', 'outline', 'rename', 'inlay_hints', 'definition', 'workspace_symbols', 'implementations', 'prepare_call_hierarchy', 'incoming_calls', 'outgoing_calls'].sort()
const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } })

async function fixtureFiles() {
  const result: Record<string, string> = {}
  for (const file of await readdir(fixtureUrl)) result[file] = await readFile(new URL(file, fixtureUrl), 'utf8')
  return result
}
async function project(t: TestContext, files?: Record<string, string>) {
  const p = await temporaryProject(files ?? await fixtureFiles())
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup()
    await cp(p.root, join(artifactRoot, t.name.replace(/[^a-z0-9]+/gi, '-')), { recursive: true })
    await p.dispose()
  })
  return { ...p, cleanups }
}
async function session(t: TestContext, p: { root: string; cleanups: Array<() => Promise<void>> }, explicit = false) {
  const traceRoot = join(artifactRoot, t.name.replace(/[^a-z0-9]+/gi, '-') + '-trace')
  await mkdir(traceRoot, { recursive: true })
  const recorder = await nativeSpawnRecorder(traceRoot)
  const mcp = await openMcp(bundle, explicit ? { ...env, PATH: '', TSC_PATH: binary } : env, recorder)
  p.cleanups.push(async () => {
    await mcp.close()
    // Stderr is also returned immediately in failed MCP assertions below.
    await writeFile(join(artifactRoot, t.name.replace(/[^a-z0-9]+/gi, '-') + '.stderr'), mcp.stderr())
  })
  const raw = (name: string, args: Record<string, unknown>) => mcp.client.callTool({ name, arguments: args })
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const response = await raw(name, args)
    const text = (response.content as Array<{ type: string; text?: string }>).filter(c => c.type === 'text').map(c => c.text).join('\n')
    assert.notEqual(response.isError, true, `${name}: ${text}\n${mcp.stderr()}`)
    return text
  }
  const json = async <T>(name: string, args: Record<string, unknown>): Promise<T> => JSON.parse(await call(name, args)) as T
  const children = async (): Promise<Array<{ pid: number; args: string[] }>> => {
    try { return (await readFile(recorder.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(p => p.args.includes('--lsp')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  return { ...mcp, raw, call, json, children, wireLog: join(traceRoot, 'native-wire.jsonl') }
}
async function compiler(root: string) {
  return new Promise<{ exitCode: number | null; stderrAndStdout: string }>((resolve, reject) => {
    const child = spawn(binary, ['--noEmit', '--pretty', 'false', '--project', root], { shell: false, stdio: 'pipe' })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Independent compiler timed out')) }, 10000)
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', exitCode => { clearTimeout(timer); resolve({ exitCode, stderrAndStdout: output }) })
  })
}
async function poll(check: () => Promise<boolean>, label: string): Promise<number> {
  const start = performance.now()
  do {
    if (await check()) { const ms = performance.now() - start; assert.ok(ms <= 2000, `${label}: ${ms}ms`); return ms }
    await delay(50)
  } while (performance.now() - start <= 2000)
  assert.fail(`${label} was not observed within 2000ms`)
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
function edgePlaces(edges: CallEdge[], root: string) {
  return edges.map(edge => ({ name: edge.item.name, file: relative(root, edge.item.file), range: edge.item.range, selectionRange: edge.item.selectionRange, fromFile: relative(root, edge.fromFile), fromRanges: edge.fromRanges }))
}

test('pinned global installation and explicit TSC_PATH both execute native 7.0.2', async t => {
  assert.ok(!relative(await realpath(prefix!), binary).startsWith('..'), binary)
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['--version'], { shell: false, stdio: 'pipe' })
    let output = ''; child.stdout.on('data', data => { output += data }); child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`Version exited ${code}`)))
  })
  assert.match(version, /^Version 7\.0\.2\s*$/)
  t.diagnostic(`${process.platform}/${process.arch}; Node ${process.version}; ${version.trim()}`)
  const p = await project(t)
  const s = await session(t, p, true)
  assert.match(await s.call('hover', { file: join(p.root, 'lib.ts'), line: 0, character: 17 }), /double.*number/s)
  await s.close()
  if (process.platform === 'darwin') {
    // Standard macOS npm-global layout, installed outside the checkout by this runner.
    const installed = await resolveTscBinary({ env: { ...env, PATH: join(prefix!, 'bin') } })
    assert.equal(installed, binary)
    t.diagnostic('macOS standard temporary npm-global prefix/bin resolver passed')
  }
})

test('all twelve MCP tools return exact real native fixture results, cold references and safe rename', async t => {
  const p = await project(t)
  const s = await session(t, p)
  const file = (name: string) => join(p.root, name)
  const main = { file: file('main.ts'), line: 2, character: 23 }
  assert.deepEqual((await s.client.listTools()).tools.map(tool => tool.name).sort(), expectedTools)
  // First semantic request: no hover/outline/definition warm-up.
  const coldReferences = (await s.call('references', main)).split('\n')
  assert.equal(coldReferences.length, 4)
  assert.deepEqual(coldReferences.sort(), [file('lib.ts') + ':0:16', file('barrel.ts') + ':0:9', file('main.ts') + ':0:9', file('main.ts') + ':2:22'].sort())
  assert.match(await s.call('hover', main), /double\(value: number\): number/)
  assert.match(await s.call('diagnostics', { file: file('main.ts') }), /TS2322/)
  const before = await fixtureFiles()
  const fixedMain = before['main.ts']!.replace("'wrong'", '42')
  assert.match(await s.call('outline', { file: file('classes.ts') }), /interface Greeter.*class Friendly/s)
  const hints = (await s.call('inlay_hints', { file: file('hints.ts'), startLine: 0, endLine: 3 })).split('\n')
  assert.ok(hints.length > 0)
  assert.ok(hints.some(hint => /type:.*number/.test(hint)))
  assert.ok(hints.some(hint => /parameter: value:/.test(hint)))
  const definitions = await s.json<LspLocation[]>('definition', { file: file('main.ts'), line: 3, character: 24 })
  assert.deepEqual(definitions.sort((a, b) => a.line - b.line), [1, 2, 3].map(line => ({ file: file('lib.ts'), line, character: 16, range: range(line, 16, 26) })))
  assert.deepEqual(await s.json<LspLocation[]>('implementations', { file: file('classes.ts'), line: 0, character: 19 }), [{ file: file('classes.ts'), line: 1, character: 13, range: range(1, 13, 21) }])
  assert.deepEqual(await s.json<WorkspaceSymbol[]>('workspace_symbols', { file: file('main.ts'), query: 'Friendly' }), [{ file: file('classes.ts'), name: 'Friendly', kind: 'class', line: 1, character: 13 }])
  const nodes = await s.json<HierarchyNode[]>('prepare_call_hierarchy', { file: file('calls.ts'), line: 1, character: 17 })
  assert.equal(nodes.length, 1)
  const node = nodes[0]!
  assert.deepEqual({ ...node, item_id: '<opaque>' }, { item_id: '<opaque>', name: 'branch', kind: 12, file: file('calls.ts'), range: range(1, 0, 61), selectionRange: range(1, 16, 22) })
  assert.match(node.item_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(edgePlaces(await s.json<CallEdge[]>('incoming_calls', { file: file('calls.ts'), item_id: node.item_id }), p.root), [{ name: 'entry', file: 'calls.ts', range: range(2, 0, 45), selectionRange: range(2, 16, 21), fromFile: 'calls.ts', fromRanges: [range(2, 33, 39)] }])
  assert.deepEqual(edgePlaces(await s.json<CallEdge[]>('outgoing_calls', { file: file('main.ts'), item_id: node.item_id }), p.root), [{ name: 'leaf', file: 'calls.ts', range: range(0, 0, 57), selectionRange: range(0, 16, 20), fromFile: 'calls.ts', fromRanges: [range(1, 47, 51)] }])
  await writeFile(file('main.ts'), fixedMain)
  assert.doesNotMatch(await s.call('diagnostics', { file: file('main.ts') }), /TS2322/)
  assert.equal((await compiler(p.root)).exitCode, 0)
  assert.match(await s.call('rename', { file: file('lib.ts'), line: 0, character: 17, newName: 'twice' }), /Renamed to "twice"/)
  const actual: Record<string, string> = {}
  for (const name of Object.keys(before)) {
    const text = await readFile(file(name), 'utf8')
    if (text !== (name === 'main.ts' ? fixedMain : before[name])) actual[name] = text
  }
  assert.deepEqual(actual, { 'lib.ts': before['lib.ts']!.replace('double', 'twice'), 'barrel.ts': "export { twice as double } from './lib.js';\n" })
  const afterRenameTsc = await compiler(p.root)
  assert.equal(afterRenameTsc.exitCode, 0, afterRenameTsc.stderrAndStdout)
  await s.close()
})

test('opened import deletion matches independent compiler and missing file isError', async t => {
  const p = await project(t, { 'main.ts': "import { value } from './dependency.js';\nexport const result = value;\n", 'dependency.ts': 'export const value = 1;\n' })
  const s = await session(t, p)
  await s.call('hover', { file: join(p.root, 'dependency.ts'), line: 0, character: 14 })
  assert.doesNotMatch(await s.call('diagnostics', { file: join(p.root, 'main.ts') }), /TS2307/)
  await rm(join(p.root, 'dependency.ts'))
  assert.match(await s.call('diagnostics', { file: join(p.root, 'main.ts') }), /TS2307/)
  const independentTsc = await compiler(p.root)
  assert.match(independentTsc.stderrAndStdout, /TS2307/)
  assert.notEqual(independentTsc.exitCode, 0)
  assert.equal((await s.raw('hover', { file: join(p.root, 'dependency.ts'), line: 0, character: 14 })).isError, true)
  await s.close()
})

test('unopened source and package declaration, new source and tsconfig refresh within 2000ms', async t => {
  const p = await project(t, {
    'main.ts': "import { local } from './dependency.js';\nimport { value } from 'fixture-dep';\nexport const a: number = local;\nexport const b: number = value;\nexport function consume() { return value; }\n",
    'dependency.ts': 'export const local = 1;\n',
    'node_modules/fixture-dep/package.json': '{"name":"fixture-dep","version":"1.0.0","types":"index.d.ts"}',
    'node_modules/fixture-dep/index.d.ts': 'export declare const value: number;\n',
    'config.ts': 'export function inferred(value) { return value; }\n',
  })
  const s = await session(t, p)
  const main = { file: join(p.root, 'main.ts') }
  assert.doesNotMatch(await s.call('diagnostics', main), /TS2322/)
  const [prepared] = await s.json<HierarchyNode[]>('prepare_call_hierarchy', { ...main, line: 4, character: 17 })
  assert.deepEqual(await s.json<CallEdge[]>('incoming_calls', { ...main, item_id: prepared!.item_id }), [])
  await writeFile(join(p.root, 'node_modules/fixture-dep/index.d.ts'), 'export declare const value: string;\n')
  t.diagnostic(`unopened node_modules declaration ${await poll(async () => /^3:\d+ .*TS2322/m.test(await s.call('diagnostics', main)), 'unopened declaration')}ms`)
  assert.equal((await s.raw('incoming_calls', { ...main, item_id: prepared!.item_id })).isError, true)
  assert.match(await s.call('hover', { ...main, line: 1, character: 10 }), /value: string/)
  await writeFile(join(p.root, 'dependency.ts'), 'export const local = "changed";\n')
  t.diagnostic(`unopened source ${await poll(async () => /^2:\d+ .*TS2322/m.test(await s.call('diagnostics', main)), 'unopened source')}ms`)
  await writeFile(join(p.root, 'added.ts'), 'export function FreshlyAdded() { return 1; }\n')
  await poll(async () => (await s.json<WorkspaceSymbol[]>('workspace_symbols', { ...main, query: 'FreshlyAdded' })).some(symbol => symbol.file === join(p.root, 'added.ts')), 'new source')
  assert.match(await s.call('diagnostics', { file: join(p.root, 'config.ts') }), /TS7006/)
  await writeFile(join(p.root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noImplicitAny":false,"target":"ES2022"}}')
  await poll(async () => !/TS7006/.test(await s.call('diagnostics', { file: join(p.root, 'config.ts') })), 'tsconfig')
  await s.close()
})

for (const mode of ['EOF', 'SIGINT', 'SIGTERM', 'Windows parent termination'] as const) {
  test(`real native lifecycle ${mode} reaps owned PIDs and preserves unrelated process`, { skip: mode === 'Windows parent termination' ? process.platform !== 'win32' : process.platform === 'win32' && mode !== 'EOF' ? 'Windows process.kill forcefully terminates; Unix signal delivery is unavailable' : false }, async t => {
    const p = await project(t)
    const s = await session(t, p)
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', shell: false })
    const unrelatedClosed = new Promise<void>(resolve => unrelated.once('close', () => resolve()))
    try {
      await s.call('hover', { file: join(p.root, 'lib.ts'), line: 0, character: 17 })
      const owned = await s.children()
      assert.equal(owned.length, 1)
      const exited = new Promise<void>(resolve => s.process.once('close', () => resolve()))
      const start = performance.now()
      if (mode === 'EOF') s.process.stdin.end(); else s.process.kill(mode === 'Windows parent termination' ? 'SIGKILL' : mode)
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP did not exit within its bounded cleanup allowance')), 4500)
        void exited.then(() => { clearTimeout(timer); resolveExit() })
      })
      assert.ok(s.process.exitCode !== null || s.process.signalCode !== null)
      await poll(async () => owned.every(child => !alive(child.pid)), 'owned native PID cleanup')
      assert.deepEqual(owned.filter(child => alive(child.pid)), [])
      assert.ok(alive(unrelated.pid!))
      t.diagnostic(`${mode} MCP exit and owned native reap: ${performance.now() - start}ms`)
    } finally { await s.close(); unrelated.kill('SIGKILL'); await unrelatedClosed }
  })
}

test('concurrent cold same-root requests spawn once, two projects isolate and crash expires hierarchy', async t => {
  const p = await project(t)
  const other = await temporaryProject({ 'other.ts': 'export const different = "other-project";\n' })
  const s = await session(t, p)
  try {
    const [a, b] = await Promise.all([
      s.call('hover', { file: join(p.root, 'lib.ts'), line: 0, character: 17 }),
      s.call('hover', { file: join(p.root, 'calls.ts'), line: 0, character: 17 }),
    ])
    assert.match(a, /double/); assert.match(b, /leaf/)
    assert.equal((await s.children()).length, 1)
    const nodes = await s.json<HierarchyNode[]>('prepare_call_hierarchy', { file: join(p.root, 'calls.ts'), line: 1, character: 17 })
    assert.match(await s.call('hover', { file: join(other.root, 'other.ts'), line: 0, character: 15 }), /other-project/)
    const children = await s.children()
    assert.equal(children.length, 2)
    assert.equal((await s.raw('incoming_calls', { file: join(other.root, 'other.ts'), item_id: nodes[0]!.item_id })).isError, true)
    assert.equal((await s.json<CallEdge[]>('incoming_calls', { file: join(p.root, 'calls.ts'), item_id: nodes[0]!.item_id })).length, 1)
    process.kill(children[0]!.pid, 'SIGKILL')
    await poll(async () => !alive(children[0]!.pid), 'native crash')
    assert.equal((await s.raw('incoming_calls', { file: join(p.root, 'calls.ts'), item_id: nodes[0]!.item_id })).isError, true)
    assert.equal((await s.children()).length, 3)
    assert.match(await s.call('hover', { file: join(p.root, 'lib.ts'), line: 0, character: 17 }), /double/)
    assert.ok(alive(children[1]!.pid))
  } finally { await s.close(); await other.dispose() }
})

test('actual native registrations preserve unrelated hierarchy IDs and invalidate unopened dependency changes and ancestor deletion', async t => {
  const outside = await temporaryProject({
    'shared-a/index.d.ts': 'export declare const valueA: number;\n',
    'shared-b/index.d.ts': 'export declare const valueB: number;\n',
    'noise.txt': 'initial\n',
  })
  const p = await project(t, { 'main.ts': '', 'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022"}}' })
  const shared = relative(p.root, outside.root).split('\\').join('/')
  const file = join(p.root, 'main.ts')
  await writeFile(file, `import { valueA } from '${shared}/shared-a/index.js';\nimport { valueB } from '${shared}/shared-b/index.js';\nexport function consume() { return valueA + valueB; }\nexport function caller() { return consume(); }\n`)
  const c = await LspClient.create(binary, pathToUri(p.root))
  const evidence: unknown[] = []
  const events: Array<{ uri: string; type: number }> = []
  const raw = c as unknown as {
    capabilities: Record<string, unknown>
    sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown>
    sendNotification(method: string, params: any): void
  }
  evidence.push({ capabilities: raw.capabilities })
  const send = raw.sendRequest.bind(c)
  raw.sendRequest = async (method, params, options) => {
    const result = await send(method, params, options)
    evidence.push({ method, params, result }); return result
  }
  const notify = raw.sendNotification.bind(c)
  raw.sendNotification = (method, params) => {
    evidence.push({ method, params })
    if (method === 'workspace/didChangeWatchedFiles') events.push(...params.changes)
    return notify(method, params)
  }
  const register = c.documentSession.register.bind(c.documentSession)
  c.documentSession.register = async params => { evidence.push({ registration: params }); return register(params) }
  try {
    assert.deepEqual(await c.diagnostics(file), [])
    assert.equal(c.documentSession.getOpenedDocuments().length, 1)
    assert.deepEqual(await c.documentSymbols(file), [
      { name: 'valueA', kind: 'variable', line: 0, character: 9, children: [] },
      { name: 'valueB', kind: 'variable', line: 1, character: 9, children: [] },
      { name: 'consume', kind: 'function', line: 2, character: 16, children: [] },
      { name: 'caller', kind: 'function', line: 3, character: 16, children: [] },
    ])
    assert.ok(evidence.some((e: any) => e.registration), 'TS7 must dynamically register actual client watchers')
    const nativeSymbols = evidence.find((e: any) => e.method === 'textDocument/documentSymbol') as { result: Array<Record<string, unknown>> }
    assert.ok(nativeSymbols.result.length > 0)
    assert.ok(nativeSymbols.result.every(symbol => symbol.range && symbol.selectionRange), 'actual TS7 DocumentSymbol format')
    let node = (await c.prepareCallHierarchy(file, 2, 17))[0]!
    const metadata = evidence.find((e: any) => e.method === 'workspace/symbol') as { result: Array<{ location: { uri: string } }> }
    assert.ok(metadata.result.some(symbol => symbol.location.uri === pathToUri(join(outside.root, 'shared-a/index.d.ts'))))
    assert.ok(metadata.result.some(symbol => symbol.location.uri === pathToUri(join(outside.root, 'shared-b/index.d.ts'))))
    assert.equal(c.documentSession.getOpenedDocuments().length, 1)
    await writeFile(join(outside.root, 'noise.txt'), 'changed unrelated\n')
    await writeFile(join(outside.root, 'unrelated.ts'), 'export const unrelated = 1;\n')
    // Wait for faithful broad delivery, then prove it did not expire the ID.
    await poll(async () => {
      await c.documentSession.flushFileEvents()
      return events.some(event => event.uri === pathToUri(join(outside.root, 'noise.txt'))) || events.some(event => event.uri === pathToUri(join(outside.root, 'unrelated.ts')))
    }, 'unrelated broad activity')
    assert.equal((await c.incomingCalls(file, node.item_id)).length, 1)
    await writeFile(join(outside.root, 'shared-a/index.d.ts'), 'export declare const valueA: string;\n')
    await poll(async () => {
      try { await c.incomingCalls(file, node.item_id); return false }
      catch (error) { assert.match(String(error), /invalid|expired/); return true }
    }, 'shared declaration invalidates hierarchy')
    assert.match(await c.hover(file, 0, 10) ?? '', /valueA: string/)
    node = (await c.prepareCallHierarchy(file, 2, 17))[0]!
    assert.equal(c.documentSession.getVersion(pathToUri(join(outside.root, 'shared-b/index.d.ts'))), undefined)
    await rm(join(outside.root, 'shared-b'), { recursive: true })
    await poll(async () => {
      try { await c.incomingCalls(file, node.item_id); return false }
      catch (error) { assert.match(String(error), /invalid|expired/); return true }
    }, 'unopened dependency ancestor deletion invalidates hierarchy')
    await poll(async () => (await c.diagnostics(file)).some(d => d.code === 2307), 'deleted shared declaration diagnostics')
  } finally {
    await c.shutdown()
    await mkdir(artifactRoot, { recursive: true })
    await writeFile(join(artifactRoot, 'actual-native-watchers.json'), JSON.stringify(evidence, null, 2))
    await outside.dispose()
  }
})


test('ordinary hover refreshes an unopened project source without hierarchy metadata', async t => {
  const p = await project(t, {
    'main.ts': "import { local } from './dependency.js';\nexport const result: number = local;\n",
    'dependency.ts': 'export const local = 1;\n',
  })
  const s = await session(t, p)
  const file = join(p.root, 'main.ts')
  assert.match(await s.call('hover', { file, line: 0, character: 10 }), /local: 1/)
  await writeFile(join(p.root, 'dependency.ts'), 'export const local = "changed";\n')
  t.diagnostic(`ordinary unopened source ${await poll(async () => /^1:\d+ .*TS2322/m.test(await s.call('diagnostics', { file })), 'ordinary unopened source')}ms`)
  const wire = (await readFile(s.wireLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(wire.filter(entry => entry.direction === 'client' && entry.message.method === 'workspace/symbol').length, 0)
  assert.equal(wire.filter(entry => entry.direction === 'client' && entry.message.method === 'textDocument/didOpen').length, 1)
  await s.close()
})


test('omitted external re-export barrel refreshes diagnostics and hierarchy without widening dependency directories', async t => {
  const outside = await temporaryProject({
    'shared/a.ts': 'export function dep(): number { return 1; }\n',
    'shared/b.ts': 'export function dep(): string { return "changed"; }\n',
    'shared/barrel.ts': "export { dep } from './a.js';\n",
    'shared/trace.log': 'initial',
    'shared/trace.json': '{}',
    'shared/unrelated-project/source.ts': 'export const unrelated = 1;\n',
    'other-project/source.ts': 'export const other = 1;\n',
  })
  const p = await project(t, { 'main.ts': '' })
  const shared = relative(p.root, outside.root).split('\\').join('/')
  const main = join(p.root, 'main.ts'); const barrel = join(outside.root, 'shared/barrel.ts')
  await writeFile(main, `import { dep } from '${shared}/shared/barrel.js';\nexport function consume(): number { return dep(); }\n`)
  const s = await session(t, p)
  const wire = async (): Promise<any[]> => (await readFile(s.wireLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  try {
    assert.doesNotMatch(await s.call('diagnostics', { file: main }), /TS2322/)
    const [node] = await s.json<HierarchyNode[]>('prepare_call_hierarchy', { file: main, line: 1, character: 17 })
    const initialWire = await wire()
    const metadataRequest = initialWire.find(e => e.direction === 'client' && e.message.method === 'workspace/symbol')
    const metadata = initialWire.find(e => e.direction === 'server' && e.message.id === metadataRequest.message.id).message.result as Array<{ location: { uri: string } }>
    assert.ok(metadata.some(symbol => symbol.location.uri === pathToUri(join(outside.root, 'shared/a.ts'))))
    assert.ok(metadata.every(symbol => symbol.location.uri !== pathToUri(barrel)), 'native symbol inventory actually omits the re-export barrel')
    const edges = (id: string) => s.json<CallEdge[]>('outgoing_calls', { file: main, item_id: id })
    assert.deepEqual((await edges(node!.item_id)).map(edge => edge.item.file), [join(outside.root, 'shared/a.ts')])
    const noise = ['shared/trace.log', 'shared/trace.json', 'shared/unrelated-project/source.ts', 'other-project/source.ts']
    for (const name of noise) await writeFile(join(outside.root, name), name.endsWith('.ts') ? 'export const changed = 2;\n' : 'changed noise')
    await poll(async () => {
      assert.equal((await edges(node!.item_id)).length, 1)
      const changes = (await wire()).filter(e => e.direction === 'client' && e.message.method === 'workspace/didChangeWatchedFiles').flatMap(e => e.message.params.changes)
      return noise.every(name => changes.some(event => event.uri === pathToUri(join(outside.root, name))))
    }, 'unrelated directory and log notifications')
    const changedAt = performance.now()
    await writeFile(barrel, "export { dep } from './b.js';\n")
    t.diagnostic(`omitted barrel expiry ${await poll(async () => {
      const response = await s.raw('outgoing_calls', { file: main, item_id: node!.item_id })
      if (!response.isError) return false
      assert.match(JSON.stringify(response.content), /invalid|expired/)
      return true
    }, 'omitted barrel hierarchy expiry')}ms`)
    t.diagnostic(`omitted barrel diagnostics ${await poll(async () => /^1:\d+ .*TS2322/m.test(await s.call('diagnostics', { file: main })), 'omitted barrel diagnostics')}ms`)
    assert.ok(performance.now() - changedAt <= 2000, 'both hierarchy expiry and diagnostics must refresh within 2000ms of the write')
    t.diagnostic(`omitted barrel combined freshness ${performance.now() - changedAt}ms`)
    const [fresh] = await s.json<HierarchyNode[]>('prepare_call_hierarchy', { file: main, line: 1, character: 17 })
    assert.deepEqual((await edges(fresh!.item_id)).map(edge => edge.item.file), [join(outside.root, 'shared/b.ts')])
    const independent = await compiler(p.root)
    assert.notEqual(independent.exitCode, 0)
    assert.match(independent.stderrAndStdout, /TS2322/)
    const finalWire = await wire()
    assert.equal(finalWire.filter(e => e.direction === 'client' && e.message.method === 'textDocument/didOpen').length, 1)
    const barrelChanges = finalWire.filter(e => e.direction === 'client' && e.message.method === 'workspace/didChangeWatchedFiles').flatMap(e => e.message.params.changes).filter(event => event.uri === pathToUri(barrel))
    assert.ok(barrelChanges.length > 0)
    assert.ok(barrelChanges.every(event => event.type === 2), 'existing barrel must be delivered as Changed without false Created')
  } finally {
    await s.close()
    await cp(outside.root, join(artifactRoot, 'omitted-barrel-external-fixture'), { recursive: true })
    await outside.dispose()
  }
})
