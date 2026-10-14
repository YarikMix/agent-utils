import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  const child = spawn(process.execPath, [entryPath], { env, stdio: 'pipe', shell: false })
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
        // EOF is not sufficient in the pinned upstream; SIGTERM runs its cleanup.
        child.kill('SIGTERM')
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
