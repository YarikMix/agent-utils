import assert from 'node:assert/strict'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { assertProjectWritePath, inlayRange, pathToUri, positionToOffset, uriToPath } from '../src/files.ts'
import { temporaryProject } from './support.ts'

test('file URI round trips reserved characters and rejects relative/nonfile input', () => {
  const file = join(process.platform === 'win32' ? 'C:\\' : '/', 'tmp', 'пробел # %.ts')
  assert.equal(uriToPath(pathToUri(file)), file)
  assert.ok(pathToUri(file).includes('%23'))
  assert.throws(() => pathToUri('relative.ts'), /absolute/i)
  assert.throws(() => uriToPath('https://example.com/a'), /file/i)
})

test('UTF-16 offsets validate exact line boundaries including CRLF and EOF', () => {
  assert.equal(positionToOffset('😀x\r\n', { line: 0, character: 2 }), 2)
  assert.equal(positionToOffset('😀x\r\n', { line: 1, character: 0 }), 5)
  for (const position of [{ line: -1, character: 0 }, { line: 0.5, character: 0 }, { line: 0, character: 2 }, { line: 1, character: 0 }, { line: 0, character: -1 }, { line: 0, character: 0.5 }]) {
    assert.throws(() => positionToOffset('x', position), /position/i)
  }
})

test('write boundary follows real paths and rejects symlink escapes and node_modules', async () => {
  const project = await temporaryProject({ 'source.ts': 'x', 'node_modules/a.ts': 'x' })
  const outside = await temporaryProject({ 'outside.ts': 'x' })
  try {
    assert.equal(await assertProjectWritePath(project.root, join(project.root, 'source.ts')), await realpath(join(project.root, 'source.ts')))
    await symlink(outside.root, join(project.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(assertProjectWritePath(project.root, join(project.root, 'escape/outside.ts')), /outside|boundary/i)
    await assert.rejects(assertProjectWritePath(project.root, join(project.root, 'node_modules/a.ts')), /node_modules/i)
    await mkdir(join(project.root, '.git')); await writeFile(join(project.root, '.git/a.ts'), 'x')
    await assert.rejects(assertProjectWritePath(project.root, join(project.root, '.git/a.ts')), /\.git/i)
  } finally { await Promise.all([project.dispose(), outside.dispose()]) }
})

test('exclusive inlay endLine reaches actual EOF without an invalid position', () => {
  assert.deepEqual(inlayRange('x', 0, 1), { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } })
  assert.deepEqual(inlayRange('x\n', 0, 2).end, { line: 1, character: 0 })
  assert.throws(() => inlayRange('x', 0, 2), /position/i)
})

test('standalone CR counts as a line ending for UTF-16 positions and EOF', () => {
  assert.equal(positionToOffset('x\ry', { line: 1, character: 1 }), 3)
  assert.deepEqual(inlayRange('x\ry', 0, 2).end, { line: 1, character: 1 })
  assert.throws(() => positionToOffset('x\ry', { line: 0, character: 2 }), /position/i)
})

test('canonical aliases inside the project are accepted', async () => {
  const project = await temporaryProject({ 'source.ts': 'x', 'node_modules/a.ts': 'x' })
  try {
    const canonical = await realpath(join(project.root, 'source.ts'))
    assert.equal(await assertProjectWritePath(project.root, canonical), canonical)
  } finally { await project.dispose() }
})

test('protected-directory project roots remain read-only', async () => {
  const project = await temporaryProject({ 'node_modules/a.ts': 'x' })
  try { await assert.rejects(assertProjectWritePath(join(project.root, 'node_modules'), join(project.root, 'node_modules/a.ts')), /node_modules/) }
  finally { await project.dispose() }
})
