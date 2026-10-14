import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LspClient } from '../src/lsp-client.ts'
import { pathToUri } from '../src/files.ts'
import { devNativeBinary, temporaryProject } from './support.ts'

const started = Date.now()
const project = await temporaryProject({
  'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","skipLibCheck":true}}',
  'пробел # %.ts': "import { value } from './dependency.js';\nexport const result = value;\nfunction twice(input: number) { return input * 2 }\nconst inferred = twice(3);\n",
  'dependency.ts': 'export const value = 1;\n',
})
const binary = devNativeBinary()
const client = await LspClient.create(binary, pathToUri(project.root))
let registrations = 0
const register = client.documentSession.register.bind(client.documentSession)
client.documentSession.register = async params => { registrations++; const started = Date.now(); console.log('native registration', JSON.stringify(params)); await register(params); console.log('native registration ready ms', Date.now() - started) }
const unregister = client.documentSession.unregister.bind(client.documentSession)
client.documentSession.unregister = async params => { console.log('native unregistration', JSON.stringify(params)); return unregister(params) }
try {
  const file = join(project.root, 'пробел # %.ts')
  const dependency = join(project.root, 'dependency.ts')
  await client.diagnostics(dependency)
  const before = await client.diagnostics(file)
  assert.equal(before.filter(d => d.severity === 'error').length, 0)
  const hints = await client.inlayHints(file, 0, 5)
  assert.ok(hints.length > 0, 'Pinned nested native settings must yield actual inlay hints')
  await rm(dependency)
  const after = await client.diagnostics(file)
  assert.ok(after.some(d => d.code === 2307), JSON.stringify(after))
  assert.equal(client.documentSession.getVersion(pathToUri(dependency)), undefined)
  assert.ok(registrations > 0, 'Native must register client watchers')
  const independent = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(binary, ['--noEmit', '--pretty', 'false', '--project', project.root], { stdio: 'pipe', shell: false })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', code => resolve({ code, output }))
  })
  assert.notEqual(independent.code, 0)
  assert.match(independent.output, /TS2307/)
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, registrations, hints: hints.length, diagnosticCodes: after.map(d => d.code), independentExit: independent.code, independentOutput: independent.output.trim(), elapsedMs: Date.now() - started }))
} finally { const closing = Date.now(); await client.shutdown(); console.log('native cleanup ms', Date.now() - closing); await project.dispose() }
