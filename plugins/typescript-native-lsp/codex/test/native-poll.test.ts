import assert from 'node:assert/strict'
import test from 'node:test'
import { pollMcpFreshness } from './native-poll.ts'

const result = (text: string, isError = false) => ({ isError, content: [{ type: 'text', text }] })

test('native freshness poll retries only the exact generation conflict within its original deadline', async () => {
  const responses = [
    result('Files changed during native request; retry the operation', true),
    result('No errors or warnings.'),
    result('2:13 error TS2322: mismatch'),
  ]
  let calls = 0
  const observed = await pollMcpFreshness(async () => { calls++; return responses.shift()! }, text => /TS2322/.test(text), 'diagnostics', 500)
  assert.equal(calls, 3)
  assert.equal(observed.transientRetries, 1)
  assert.ok(observed.ms <= 500)

  for (const error of ['EMFILE: too many open files', 'Files changed during native request; retry the operation extra']) {
    await assert.rejects(() => pollMcpFreshness(async () => result(error, true), () => true, 'diagnostics', 500), new RegExp(error.split(':')[0]!))
  }
  await assert.rejects(() => pollMcpFreshness(async () => result('Files changed during native request; retry the operation', true), () => true, 'diagnostics', 20), /not observed within 20ms/)
})
