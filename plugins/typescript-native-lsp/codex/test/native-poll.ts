import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

type TextResponse = { isError?: boolean; content?: Array<{ type: string; text?: string }> }
const transient = 'Files changed during native request; retry the operation'

/** Poll an actual MCP result after a file change, tolerating only the native generation race. */
export async function pollMcpFreshness(
  request: () => Promise<unknown>,
  matches: (text: string) => boolean,
  label: string,
  deadlineMs = 2000,
): Promise<{ ms: number; transientRetries: number }> {
  const start = performance.now()
  let transientRetries = 0
  do {
    const candidate = await request()
    assert.ok(candidate && typeof candidate === 'object' && 'content' in candidate, `${label}: expected MCP content`)
    const response = candidate as TextResponse
    assert.ok(response.content, `${label}: expected MCP content`)
    const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
    if (response.isError === true) {
      if (text === transient) transientRetries++
      else assert.fail(`${label}: ${text}`)
    } else if (matches(text)) {
      const ms = performance.now() - start
      assert.ok(ms <= deadlineMs, `${label}: ${ms}ms`)
      return { ms, transientRetries }
    }
    await delay(50)
  } while (performance.now() - start <= deadlineMs)
  assert.fail(`${label} was not observed within ${deadlineMs}ms; transient retries=${transientRetries}`)
}
