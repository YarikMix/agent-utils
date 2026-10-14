import { appendFileSync } from 'node:fs'

const options = JSON.parse(process.argv[2] || '{}')
let buffer = Buffer.alloc(0)
const frame = message => {
  const body = JSON.stringify(message)
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n${options.contentType ? "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n" : ""}\r\n${body}`)
}
function send(message) {
  const bytes = frame(message)
  if (options.split) {
    process.stdout.write(bytes.subarray(0, 17))
    setTimeout(() => process.stdout.write(bytes.subarray(17)), 5)
  } else process.stdout.write(bytes)
}
function handle(message) {
  if (options.log) appendFileSync(options.log, JSON.stringify(message) + '\n')
  if (message.method === 'initialize') {
    if (options.noise) process.stderr.write('native compiler warning\n'.repeat(10000))
    if (options.hangInitialize) return
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: options.encoding ? { positionEncoding: options.encoding } : {} } })
  } else if (message.method === 'shutdown') {
    if (!options.hangShutdown) send({ jsonrpc: '2.0', id: message.id, result: null })
  } else if (message.method === 'exit') {
    if (!options.hangShutdown) process.exit(0)
  } else if (message.method === 'textDocument/hover') {
    if (options.crash) { process.exit(7); return }
    if (options.malformed) { process.stdout.write('Content-Length: 1\r\n\r\n{'); return }
    if (options.badHeader) { process.stdout.write('Content-Length: no\r\n\r\n{}'); return }
    if (options.largeHeader) { process.stdout.write(Buffer.concat([Buffer.from('X-Noise: ' + 'x'.repeat(10000) + '\r\n'), frame({ jsonrpc: '2.0', id: message.id, result: { contents: 'oversized header' } })])); return }
    if (options.badEnvelope) { send({ jsonrpc: '1.0', id: message.id, result: null }); return }
    if (options.serverError) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'fixture error' } }); return }
    const character = message.params.position.character
    const response = { jsonrpc: '2.0', id: message.id, result: { contents: character === 1 ? 'first' : character === 2 ? 'second' : 'Привет 😀' } }
    if (options.delayFirst && character === 1) setTimeout(() => send(response), options.delayFirst)
    else if (options.coalesced) process.stdout.write(Buffer.concat([frame({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'ignored' } }), frame(response)]))
    else send(response)
  } else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: [] })
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end === -1) return
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/)[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length)
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body.toString()))
  }
})
process.stdin.on('end', () => process.exit(0))
if (options.ignoreTerm) process.on('SIGTERM', () => {})
