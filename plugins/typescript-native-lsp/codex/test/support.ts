import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Explicit development-only binary; runtime resolution is tested separately. */
export function devNativeBinary(): string {
  const require = createRequire(import.meta.url)
  const fromTypeScript = createRequire(require.resolve('typescript/package.json'))
  const packagePath = fromTypeScript.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`)
  return join(dirname(packagePath), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
}

/** SDK protocol client around a test-owned stdio process, shared by future tests. */
export async function openMcp(entryPath: string, env?: NodeJS.ProcessEnv): Promise<{
  client: Client
  process: ChildProcessWithoutNullStreams
  close(): Promise<void>
}> {
  const child = spawn(process.execPath, [...(entryPath.endsWith('.ts') ? ['--import', 'tsx'] : []), entryPath], { env, stdio: 'pipe', shell: false })
  const client = new Client({ name: 'typescript-native-lsp-test', version: '1.0.0' })
  const buffer = new ReadBuffer()
  let stderr = ''
  let closed: Promise<void> | undefined
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192) })
  const transport: Transport = {
    async start() {
      child.on('error', error => transport.onerror?.(error))
      child.on('close', () => transport.onclose?.())
      child.stdout.on('data', (chunk: Buffer) => {
        buffer.append(chunk)
        try {
          for (;;) {
            const message = buffer.readMessage()
            if (message === null) break
            transport.onmessage?.(message)
          }
        } catch (error) {
          transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    async send(message) {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve())
      })
    },
    close() {
      return closed ??= new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
        const timeout = setTimeout(() => { child.kill('SIGKILL') }, 5000)
        child.once('close', () => { clearTimeout(timeout); resolve() })
        // EOF runs the same bounded cleanup as SIGINT/SIGTERM.
        child.stdin.end()
      })
    },
  }
  try {
    await client.connect(transport, { timeout: 30_000 })
  } catch (error) {
    await transport.close()
    throw new Error(`MCP connection failed: ${stderr}`, { cause: error })
  }
  return { client, process: child, close: () => client.close() }
}

/** Isolated on-disk project with tsconfig, removed even after a failing assertion. */
export async function temporaryProject(files: Record<string, string>): Promise<{
  root: string
  dispose(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'typescript-native-lsp-test-'))
  try {
    for (const [file, text] of Object.entries({ 'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022"}}', ...files })) {
      const path = join(root, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return { root, dispose: () => rm(root, { recursive: true, force: true }) }
}

/** POSIX native executable for real version/timeout probes; never a shell launcher. */
export async function nativeVersionProbe(root: string, version: string, hang = false): Promise<string> {
  const source = join(root, 'version.c')
  const binary = join(root, 'native tsc')
  await writeFile(source, `#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc, char **argv) {\nif (argc != 2 || strcmp(argv[1], "--version")) return 2;\n${hang ? 'printf("PID %d\\n", getpid()); fflush(stdout); for (;;) pause();' : `puts(${JSON.stringify(version)});`}\nreturn 0;\n}\n`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cc', [source, '-o', binary], { stdio: 'pipe', shell: false })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Native probe compilation failed: ${stderr}`)))
  })
  return binary
}

/** Real framed peer; injected only at the native process spawning boundary. */
export function fakeLsp(options: Record<string, unknown> = {}) {
  const spawnOwned = spawn
  const processes: ChildProcessWithoutNullStreams[] = []
  const roots: string[] = []
  return {
    processes, roots,
    spawnProcess(_binary: string, projectRoot: string): ChildProcessWithoutNullStreams {
      roots.push(projectRoot)
      const child = spawnOwned(process.execPath, [fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url)), JSON.stringify(options)], { cwd: projectRoot, stdio: 'pipe', shell: false })
      processes.push(child)
      return child
    },
    async dispose() {
      await Promise.all(processes.map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
        child.once('close', () => resolve())
        child.kill('SIGKILL')
      })))
    },
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for test condition')
    await delay(10)
  }
}

export async function recordedMessages(log: string): Promise<Array<{ id?: number; method?: string; params?: any }>> {
  try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch { return [] }
}

/** Native owned PID fixture used to test EOF while discovery/initialize is pending. */
export async function nativeLifetimeProbe(root: string, pidPath: string, stage: string): Promise<string> {
  const source = join(root, 'lifetime.c')
  const binary = join(root, 'native-lifetime')
  const code = `#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc, char **argv) {\nif (argc > 1 && !strcmp(argv[1], "--version") && ${stage === 'initialize' ? '1' : '0'}) { puts("Version 7.0.0"); return 0; }\nFILE *file = fopen(${JSON.stringify(pidPath)}, "w"); fprintf(file, "%d", getpid()); fclose(file);\nfor (;;) pause();\n}\n`
  await writeFile(source, code)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cc', [source, '-o', binary], { stdio: 'pipe', shell: false })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Native lifetime probe compilation failed: ${stderr}`)))
  })
  return binary
}

/** Test-only native launch boundary: version probe then the owned framed fixture. */
export async function nativeProtocolPeer(root: string, options: Record<string, unknown>): Promise<string> {
  const source = join(root, 'protocol-peer.c')
  const binary = join(root, 'protocol-peer')
  const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url))
  const code = `#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc, char **argv) {\nif (argc > 1 && !strcmp(argv[1], "--version")) { puts("Version 7.0.0"); return 0; }\nexecl(${JSON.stringify(process.execPath)}, "node", ${JSON.stringify(fixture)}, ${JSON.stringify(JSON.stringify(options))}, (char *)0); return 2;\n}\n`
  await writeFile(source, code)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cc', [source, '-o', binary], { stdio: 'pipe', shell: false })
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Protocol peer compilation failed: ${stderr}`)))
  })
  return binary
}
