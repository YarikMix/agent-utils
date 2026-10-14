import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { endPosition, pathToUri } from "./files.ts"
import {
  type ClientOptions,
  type LspCodeAction,
  type LspDiagnostic,
  type LspInlayHint,
  type LspLocation,
  type LspSymbol,
  type LspTextEdit,
  LspClient,
} from "./lsp-client.ts"

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export interface PoolOptions {
  idleTimeoutMs?: number
  createClient?: (binaryPath: string, rootUri: string, options?: ClientOptions) => Promise<LspClient>
}

interface PoolEntry {
  initialization: Promise<LspClient>
  controller: AbortController
  client?: LspClient
  idleTimer?: ReturnType<typeof setTimeout>
  leases: number
  queue: Promise<void>
}

/** One memoized native session and serialized operation queue per project root. */
export class TypeScriptPool {
  private entries = new Map<string, PoolEntry>()
  private retiring = new Set<Promise<void>>()
  private closed = false
  private shutdownPromise?: Promise<void>
  private idleTimeoutMs: number
  private createClient: NonNullable<PoolOptions["createClient"]>

  constructor(private resolveBinary: (signal?: AbortSignal) => Promise<string>, options: PoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.createClient = options.createClient ?? LspClient.create
  }

  /** Keep a lease through initialization, queueing and the complete operation. */
  withClient<T>(filePath: string, operation: (client: LspClient) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("TypeScript pool is closed"))
    pathToUri(filePath)
    const root = findProjectRoot(filePath)
    let entry = this.entries.get(root)
    if (entry?.client && !entry.client.isAlive) {
      clearTimeout(entry.idleTimer)
      this.entries.delete(root)
      void this.retire(entry.client)
      entry = undefined
    }
    if (!entry) {
      const controller = new AbortController()
      // Install before any async resolver/client factory runs.
      const newEntry: PoolEntry = {
        controller,
        leases: 0,
        queue: Promise.resolve(),
        initialization: Promise.resolve().then(async () => {
          const binary = await this.resolveBinary(controller.signal)
          if (this.closed || controller.signal.aborted) throw new Error("TypeScript pool initialization aborted")
          const client = await this.createClient(binary, pathToUri(root), { signal: controller.signal })
          if (this.closed || controller.signal.aborted) {
            await client.shutdown()
            throw new Error("TypeScript pool initialization aborted")
          }
          newEntry.client = client
          return client
        }).catch(error => {
          if (this.entries.get(root) === newEntry) this.entries.delete(root)
          throw error
        }),
      }
      entry = newEntry
      this.entries.set(root, entry)
    }
    const lease = entry
    lease.leases++
    clearTimeout(lease.idleTimer)
    // Attach a handler immediately: initialization may fail before queue entry.
    const ready = lease.initialization.then(client => ({ client }), error => ({ error }))
    const result = lease.queue.then(async () => {
      const initialized = await ready
      if (this.closed) throw new Error("TypeScript pool is closed")
      if ("error" in initialized) throw initialized.error
      if (!initialized.client.isAlive) throw new Error("LSP client is not alive")
      return operation(initialized.client)
    })
    lease.queue = result.then(() => {}, () => {})
    return result.finally(() => {
      lease.leases--
      if (!this.closed && lease.leases === 0 && this.entries.get(root) === lease) {
        lease.idleTimer = setTimeout(() => {
          if (lease.leases !== 0 || this.entries.get(root) !== lease) return
          this.entries.delete(root)
          if (lease.client) void this.retire(lease.client)
        }, this.idleTimeoutMs)
      }
    })
  }

  hoverWithDefinition(filePath: string, line: number, character: number): Promise<{ hover: string | null; definition: LspLocation | null }> {
    return this.withClient(filePath, client => client.withDocumentSnapshot(filePath, async () => {
      let failed = false
      let firstError: unknown
      const captureFailure = (error: unknown): never => {
        if (!failed) { failed = true; firstError = error }
        throw error
      }
      // Keep the lease until both requests settle, including after one fails.
      const [hover, definitions] = await Promise.allSettled([
        client.hover(filePath, line, character).catch(captureFailure),
        client.definition(filePath, line, character).catch(captureFailure),
      ])
      if (hover.status === "rejected" || definitions.status === "rejected") throw firstError
      return { hover: hover.value, definition: definitions.value[0] ?? null }
    }))
  }

  diagnosticsWithFixes(filePath: string): Promise<{ diagnostics: LspDiagnostic[]; actions: LspCodeAction[] }> {
    return this.withClient(filePath, client => client.withDocumentSnapshot(filePath, async content => {
      const diagnostics = await client.diagnostics(filePath)
      const actions = await client.codeActions(filePath, { start: { line: 0, character: 0 }, end: endPosition(content) }, diagnostics)
      return { diagnostics, actions }
    }))
  }

  references(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    return this.withClient(filePath, client => client.references(filePath, line, character))
  }

  outline(filePath: string): Promise<LspSymbol[]> {
    return this.withClient(filePath, client => client.documentSymbols(filePath))
  }

  rename(filePath: string, line: number, character: number, newName: string): Promise<LspTextEdit[]> {
    return this.withClient(filePath, client => client.rename(filePath, line, character, newName))
  }

  inlayHints(filePath: string, startLine: number, endLine: number): Promise<LspInlayHint[]> {
    return this.withClient(filePath, client => client.inlayHints(filePath, startLine, endLine))
  }

  /** Keep idle/crashed sessions owned until their close promise settles. */
  private retire(client: LspClient): Promise<void> {
    const closing = client.shutdown().catch(() => {})
    this.retiring.add(closing)
    void closing.then(() => this.retiring.delete(closing))
    return closing
  }

  /** Abort pending discovery/initialize and close all owned sessions in parallel. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) {
      clearTimeout(entry.idleTimer)
      entry.controller.abort()
    }
    this.shutdownPromise = Promise.all([...this.retiring, ...entries.map(async entry => {
      try { await (await entry.initialization).shutdown() } catch { /* Failed/aborted initialization already reaps its child. */ }
    })]).then(() => {})
    return this.shutdownPromise
  }
}

/** Nearest tsconfig wins; an unconfigured file uses its containing directory. */
function findProjectRoot(filePath: string): string {
  let dir = dirname(filePath)
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(filePath)
}
