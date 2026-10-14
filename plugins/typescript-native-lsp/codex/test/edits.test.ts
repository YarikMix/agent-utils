import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { DocumentSession } from '../src/documents.ts'
import { applyWorkspaceEdit, prepareWorkspaceEdit, type EditIO } from '../src/edits.ts'
import { pathToUri } from '../src/files.ts'
import { temporaryProject } from './support.ts'

const edit = (start: number, end: number, newText = 'renamed') => ({ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText })
async function fixture() {
  const project = await temporaryProject({ 'проект #100% с пробелом/a.ts': '\uFEFFconst face = "😀"; foo; foo;\r\n', 'проект #100% с пробелом/b.ts': 'foo\r\n' })
  const root = join(project.root, 'проект #100% с пробелом'); const a = join(root, 'a.ts'); const b = join(root, 'b.ts')
  const docs = new DocumentSession(root, () => {})
  const before = await Promise.all([fs.readFile(a), fs.readFile(b)])
  const changes = { [pathToUri(a)]: [edit(20, 23), edit(25, 28)], [pathToUri(b)]: [edit(0, 3)] }
  return { root, a, b, docs, before, changes, bytes: () => Promise.all([fs.readFile(a), fs.readFile(b)]), async close() { await docs.close(); await project.dispose() } }
}

test('multi-file rename preserves exact BOM CRLF and UTF-16 bytes in encoded paths and mode', async () => {
  const f = await fixture()
  try {
    await fs.chmod(f.a, 0o764)
    const result = await applyWorkspaceEdit(await prepareWorkspaceEdit(f.root, { changes: f.changes }, f.docs))
    assert.deepEqual(await fs.readFile(f.a), Buffer.from('\uFEFFconst face = "😀"; renamed; renamed;\r\n'))
    assert.deepEqual(await fs.readFile(f.b), Buffer.from('renamed\r\n'))
    assert.equal(result.editCount, 3); assert.equal(result.files.length, 2)
    if (process.platform !== 'win32') assert.equal((await fs.stat(f.a)).mode & 0o777, 0o764)
  } finally { await f.close() }
})

test('documentChanges accepts null and current opened version, rejects stale disk snapshots', async () => {
  const f = await fixture()
  try {
    await f.docs.sync(f.b)
    for (const version of [null, 1]) assert.equal((await prepareWorkspaceEdit(f.root, { documentChanges: [{ textDocument: { uri: pathToUri(f.b), version }, edits: [edit(0, 3)] }] }, f.docs)).files.length, 1)
    await assert.rejects(prepareWorkspaceEdit(f.root, { documentChanges: [{ textDocument: { uri: pathToUri(f.b), version: 2 }, edits: [edit(0, 3)] }] }, f.docs), /version/)
    await fs.writeFile(f.b, 'other\r\n')
    await assert.rejects(prepareWorkspaceEdit(f.root, { changes: f.changes }, f.docs), /snapshot|changed/)
  } finally { await f.close() }
})

test('rejects entire invalid WorkspaceEdit before any write', async () => {
  const f = await fixture(); const uri = pathToUri(f.b)
  try {
    const cases = [
      { changes: f.changes, documentChanges: [] }, { documentChanges: [{ kind: 'delete', uri }] },
      { changes: { [uri]: [{ ...edit(0, 3), annotationId: 'a' }] } }, { changes: f.changes, changeAnnotations: {} },
      ...[[edit(0, 3), edit(0, 3)], [edit(0, 2), edit(1, 3)], [edit(0, 0), edit(0, 3)], [edit(1, 0)], [edit(0, 100)], [edit(-1, 1)]].map(edits => ({ changes: { [uri]: edits } })),
      { documentChanges: [{ textDocument: { uri, version: 1 }, edits: [edit(0, 3)] }] },
      { documentChanges: [{ textDocument: { uri }, edits: [edit(0, 3)] }] },
      { changes: { ...f.changes, [pathToUri(join(f.root, 'missing.ts'))]: [edit(0, 1)] } },
    ]
    for (const value of cases) { await assert.rejects(prepareWorkspaceEdit(f.root, value, f.docs), /edit|version|project|position|ENOENT/i); assert.deepEqual(await f.bytes(), f.before) }
  } finally { await f.close() }
})

test('rejects outside symlinks, canonical duplicates and inaccessible files', async () => {
  const f = await fixture()
  try {
    const outside = join(f.root, '..', 'outside.ts'); await fs.writeFile(outside, 'foo')
    const link = join(f.root, 'link.ts'); await fs.symlink(outside, link)
    await assert.rejects(prepareWorkspaceEdit(f.root, { changes: { [pathToUri(link)]: [edit(0, 3)] } }, f.docs), /project/)
    await fs.rm(link); await fs.symlink(f.b, link)
    await assert.rejects(prepareWorkspaceEdit(f.root, { changes: { [pathToUri(link)]: [edit(0, 3)], [pathToUri(f.b)]: [edit(0, 3)] } }, f.docs), /duplicate/i)
    const io = { ...fs, access: async () => { throw new Error('EACCES denied') } } as EditIO
    await assert.rejects(prepareWorkspaceEdit(f.root, { changes: f.changes }, f.docs, io), /EACCES/)
    assert.deepEqual(await f.bytes(), f.before)
  } finally { await f.close() }
})

for (const phase of ['write', 'chmod', 'replace', 'concurrent', 'rollback'] as const) test(`failure during ${phase} reports state and cleans staged artifacts`, async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorkspaceEdit(f.root, { changes: f.changes }, f.docs)
    let writes = 0; let replacements = 0; let successReported = false
    const io: EditIO = { ...fs,
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => { if (phase === 'write' && ++writes === 2) throw new Error('second write failed'); return fs.writeFile(...args) }) as typeof fs.writeFile,
      chmod: async (...args) => { if (phase === 'chmod') throw new Error('chmod failed'); return fs.chmod(...args) },
      rename: async (from, to) => {
        replacements++
        if (replacements === 2 && !['write', 'chmod'].includes(phase)) { if (phase === 'concurrent') await fs.writeFile(f.a, 'external'); throw new Error('second rename failed') }
        if (replacements === 3 && phase === 'rollback') throw new Error('rollback failed')
        return fs.rename(from, to)
      },
    }
    await assert.rejects(async () => { await applyWorkspaceEdit(prepared, io); successReported = true }, error => {
      assert.match(String(error), /rename|write|partial/i); assert.match(String(error), /restored|changed|unchanged/i)
      if (phase === 'concurrent' || phase === 'rollback') assert.ok(String(error).includes(f.a))
      return true
    })
    assert.equal(successReported, false)
    if (['write', 'chmod', 'replace'].includes(phase)) assert.deepEqual(await f.bytes(), f.before)
    if (phase === 'concurrent') assert.equal(await fs.readFile(f.a, 'utf8'), 'external')
    assert.deepEqual((await fs.readdir(f.root)).sort(), ['a.ts', 'b.ts'])
  } finally { await f.close() }
})

test('pre-apply snapshot recheck protects concurrent writes without creating artifacts', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorkspaceEdit(f.root, { changes: f.changes }, f.docs)
    await fs.writeFile(f.b, 'external')
    await assert.rejects(applyWorkspaceEdit(prepared), /snapshot|changed/)
    assert.deepEqual(await fs.readFile(f.a), f.before[0]); assert.equal(await fs.readFile(f.b, 'utf8'), 'external')
    assert.deepEqual((await fs.readdir(f.root)).sort(), ['a.ts', 'b.ts'])
  } finally { await f.close() }
})

test('pool holds lease through write and sync, invalidates hierarchy and passes full native edits', async () => {
  const { LspClient } = await import('../src/lsp-client.ts')
  const { TypeScriptPool } = await import('../src/pool.ts')
  const { fakeLsp } = await import('./support.ts')
  const f = await fixture(); const uri = pathToUri(f.b); const range = edit(0, 3).range
  const value = { changes: f.changes }
  const fake = fakeLsp({ capabilities: { callHierarchyProvider: true }, results: { 'textDocument/rename': value, 'textDocument/prepareCallHierarchy': [{ name: 'foo', kind: 12, uri, range, selectionRange: range }] } })
  const pool = new TypeScriptPool(async () => 'fake', { createClient: (binary, root, options) => LspClient.create(binary, root, { ...options, spawnProcess: fake.spawnProcess }) })
  try {
    const [node] = await pool.prepareCallHierarchy(f.b, 0, 0)
    await pool.withClient(f.b, async client => { assert.deepEqual(await client.rename(f.b, 0, 0, 'renamed'), value) })
    const renamed = pool.rename(f.b, 0, 0, 'renamed')
    const queued = pool.withClient(f.b, async client => {
      assert.equal(await fs.readFile(f.b, 'utf8'), 'renamed\r\n')
      assert.equal(client.documentSession.getText(uri), 'renamed\r\n')
      assert.equal(client.documentSession.getVersion(uri), 2)
      assert.equal(client.documentSession.getText(pathToUri(f.a)), '\uFEFFconst face = "😀"; renamed; renamed;\r\n')
      assert.equal(client.documentSession.getVersion(pathToUri(f.a)), 1)
      await assert.rejects(client.incomingCalls(f.b, node!.item_id), /hierarchy|invalid/i)
    })
    assert.equal((await renamed).editCount, 3); await queued
  } finally { await pool.shutdown(); await fake.dispose(); await f.close() }
})

test('client returns resource operations verbatim so preparation can reject them', async () => {
  const { LspClient } = await import('../src/lsp-client.ts'); const { fakeLsp } = await import('./support.ts')
  const f = await fixture(); const value = { documentChanges: [{ kind: 'delete', uri: pathToUri(f.b) }] }
  const fake = fakeLsp({ results: { 'textDocument/rename': value } }); const client = await LspClient.create('fake', pathToUri(f.root), { spawnProcess: fake.spawnProcess })
  try { assert.deepEqual(await client.rename(f.b, 0, 0, 'other'), value); assert.deepEqual(await f.bytes(), f.before) }
  finally { await client.shutdown(); await fake.dispose(); await f.close() }
})

test('null and empty workspace edits are successful no-ops', async () => {
  const f = await fixture()
  try {
    for (const value of [null, {}, { changes: {} }, { documentChanges: [] }]) {
      assert.deepEqual(await applyWorkspaceEdit(await prepareWorkspaceEdit(f.root, value, f.docs)), { editCount: 0, files: [] })
      assert.deepEqual(await f.bytes(), f.before)
    }
  } finally { await f.close() }
})
