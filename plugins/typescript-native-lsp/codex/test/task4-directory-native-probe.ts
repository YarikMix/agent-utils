import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LspClient } from '../src/lsp-client.ts'
import { pathToUri } from '../src/files.ts'
import { devNativeBinary, temporaryProject, waitFor } from './support.ts'

// Development-only causal probe: suppress every automatic watched-file batch.
// The single delivered notification names a directory, never its unopened files.
const project = await temporaryProject({
  'project/tsconfig.json': '{"compilerOptions":{"strict":true,"module":"NodeNext","moduleResolution":"NodeNext"}}',
  'project/source.ts': "import { value } from '../dependency/index.js';\nexport const result = value;\n",
  'dependency/index.d.ts': 'export declare const value: number;\n',
})
const binary = devNativeBinary()
const root = join(project.root, 'project')
const source = join(root, 'source.ts')
const directory = join(project.root, 'dependency')
const client = await LspClient.create(binary, pathToUri(root))
const session = client.documentSession as unknown as { notify(method: string, params: unknown): void }
const notify = session.notify
let suppressedBatches = 0
session.notify = (method, params) => {
  if (method === 'workspace/didChangeWatchedFiles') { suppressedBatches++; return }
  notify(method, params)
}
try {
  const before = await client.diagnostics(source)
  assert.ok(!before.some(d => d.code === 2307), JSON.stringify(before))
  assert.equal(client.documentSession.getVersion(pathToUri(join(directory, 'index.d.ts'))), undefined)
  await rm(directory, { recursive: true })
  const withoutNotification = await client.diagnostics(source)
  assert.ok(!withoutNotification.some(d => d.code === 2307), 'Baseline must remain stale without watcher notifications')
  const changes = [{ uri: pathToUri(directory), type: 3 }]
  const started = Date.now()
  notify('workspace/didChangeWatchedFiles', { changes })
  let codes: Array<string | number | undefined> = []
  await waitFor(async () => { codes = (await client.diagnostics(source)).map(d => d.code); return codes.includes(2307) })
  const independent = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(binary, ['--noEmit', '--pretty', 'false', '--project', root], { stdio: 'pipe', shell: false })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', code => resolve({ code, output }))
  })
  assert.notEqual(independent.code, 0); assert.match(independent.output, /TS2307/)
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, unopenedDependency: true, baselineCodes: withoutNotification.map(d => d.code), deliveredChanges: changes, codes, suppressedBatches, invalidationMs: Date.now() - started, independent }))
} finally { const started = Date.now(); await client.shutdown(); console.log('native cleanup ms', Date.now() - started); await project.dispose() }
