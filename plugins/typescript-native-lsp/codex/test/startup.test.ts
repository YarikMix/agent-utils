import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { TypeScriptPool } from '../src/pool.ts'
import { openMcp, temporaryProject } from './support.ts'

test('pool defers compiler resolution until the first file tool', async () => {
  let spawnCountBeforeFirstTool = 0
  const pool = new TypeScriptPool(async () => { spawnCountBeforeFirstTool++; throw new Error('compiler unavailable') })
  assert.equal(spawnCountBeforeFirstTool, 0)
  await assert.rejects(pool.outline('/missing/file.ts'), /compiler unavailable/)
  assert.equal(spawnCountBeforeFirstTool, 1)
  await pool.shutdown()
})

test('built MCP initializes and lists tools without tsc, then gives actionable tool error', async () => {
  await promisify(execFile)(process.execPath, ['scripts/build.mjs'])
  const fixture = await temporaryProject({ 'source.ts': 'export const value = 1' })
  try {
    const session = await openMcp(join(process.cwd(), 'dist/server.js'), { PATH: '', TSC_PATH: '' })
    try {
      const { tools } = await session.client.listTools()
      assert.equal(tools.length, 12)
      const response = await session.client.callTool({ name: 'outline', arguments: { file: join(fixture.root, 'source.ts') } })
      assert.equal(response.isError, true)
      assert.match(JSON.stringify(response.content), /PATH.*TSC_PATH/)
    } finally { await session.close() }
  } finally { await fixture.dispose() }
})
