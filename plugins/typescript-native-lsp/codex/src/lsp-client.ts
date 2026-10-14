import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { z } from "zod"
import { HierarchyStore, callHierarchyItemSchema, parseHierarchyItem, type HierarchyNode, type CallEdge } from "./hierarchy.ts"
import { parseWorkspaceSymbol, workspaceSymbolSchema, rangeSchema, type WorkspaceSymbol } from "./protocol.ts"
import { DocumentSession } from "./documents.ts"
import { inlayRange, pathToUri, positionToOffset, uriToPath } from "./files.ts"
import { configurationResults, diagnosticItemSchema, INLAY_HINT_KIND_LABELS, parseLocations, parseSymbols, parseWorkspaceEdit, positionSchema, requireCapability, SEVERITY_LABELS, textEditSchema, type LspCodeAction, type LspDiagnostic, type LspInlayHint, type LspLocation, type LspSymbol } from "./protocol.ts"
export type { LspCodeAction, LspDiagnostic, LspInlayHint, LspLocation, LspSymbol, LspTextEdit, Position, Range } from "./protocol.ts"

const REQUEST_TIMEOUT_MS = 30_000

/** JSON-RPC response and server-request envelope accepted from TypeScript. */
const jsonRpcMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ClientOptions {
  spawnProcess?: (binaryPath: string, projectRoot: string) => ChildProcessWithoutNullStreams
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  signal?: AbortSignal
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  dispose: () => void
}

/**
 * LSP JSON-RPC client that communicates with a TypeScript process over stdio.
 * Handles Content-Length message framing, request/response correlation,
 * server-initiated requests (e.g. client/registerCapability), and automatic
 * document open/change tracking.
 */
export class LspClient {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private buffer = Buffer.alloc(0)
  readonly projectRoot: string
  readonly documentSession: DocumentSession
  private capabilities: Record<string, unknown> = {}
  private hierarchy = new HierarchyStore()
  private hierarchyDependenciesGeneration?: number
  private diagnosticCache = new Map<string, { resultId?: string; items: LspDiagnostic[] }>()
  private alive = true
  private closing = false
  private shutdownPromise?: Promise<void>
  private writeQueue: Promise<void> = Promise.resolve()
  private closed: Promise<void>
  private requestTimeoutMs: number
  private shutdownTimeoutMs: number
  private removeAbortListener: () => void = () => {}

  private constructor(binaryPath: string, private rootUri: string, options: ClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2000
    const projectRoot = this.projectRoot = uriToPath(rootUri)
    this.proc = options.spawnProcess
      ? options.spawnProcess(binaryPath, projectRoot)
      : spawn(binaryPath, ["--lsp", "--stdio"], { cwd: projectRoot, stdio: "pipe", shell: false })
    this.documentSession = new DocumentSession(projectRoot, (method, params) => this.sendNotification(method, params))
    this.closed = new Promise(resolve => {
      this.proc.once("close", () => {
        this.alive = false
        this.rejectPending(new Error("TypeScript process closed"))
        this.removeAbortListener()
        resolve()
      })
    })
    this.proc.once("error", error => this.failTransport(error))
    this.proc.once("exit", code => {
      this.alive = false
      this.rejectPending(new Error(`TypeScript exited with code ${code}`))
    })
    this.proc.stdin.on("error", error => this.failTransport(error))
    this.proc.stdout.on("error", error => this.failTransport(error))
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      try { this.drainBuffer() } catch (error) {
        this.failTransport(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.proc.stdout.once("end", () => {
      if (!this.closing) this.failTransport(new Error("TypeScript transport closed"))
    })
    let stderrBudget = 8192
    this.proc.stderr.on("data", (chunk: Buffer) => {
      if (stderrBudget <= 0) return
      const text = chunk.subarray(0, stderrBudget).toString("utf8")
      stderrBudget -= chunk.length
      console.error(text)
    })
    this.proc.stderr.on("error", error => this.failTransport(error))
    if (options.signal) {
      const abort = () => {
        this.rejectPending(new Error("LSP initialization aborted"))
        this.failTransport(new Error("LSP session aborted"))
      }
      options.signal.addEventListener("abort", abort, { once: true })
      this.removeAbortListener = () => options.signal?.removeEventListener("abort", abort)
      if (options.signal.aborted) abort()
    }
  }

  static async create(binaryPath: string, rootUri: string, options: ClientOptions = {}): Promise<LspClient> {
    if (options.signal?.aborted) throw new Error("LSP initialization aborted")
    const client = new LspClient(binaryPath, rootUri, options)
    try {
      await client.initialize(options.signal)
      client.removeAbortListener()
      return client
    } catch (error) {
      await client.shutdown()
      throw error
    }
  }

  get isAlive(): boolean { return this.alive && !this.closing }

  /**
   * Get hover information at a position in a file
   *
   * @param filePath - Absolute path to the source file.
   * @param line - Zero-based source line.
   * @param character - Zero-based character offset.
   */
  async hover(
    filePath: string,
    line: number,
    character: number,
    options?: RequestOptions,
  ): Promise<string | null> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    const content = await this.prepareDocument(filePath)

    positionToOffset(content, { line, character })
    const result: unknown = await this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    }, options)

    const parsed = z.object({ contents: z.unknown() }).safeParse(result)
    if (result === null) return null
    if (!parsed.success) throw new Error("Invalid LSP protocol hover response")

    return formatHoverContents(parsed.data.contents)
  }

  /**
   * Get definition location(s) for a symbol at a position
   *
   * @param filePath - Absolute path to the source file.
   * @param line - Zero-based source line.
   * @param character - Zero-based character offset.
   */
  async definition(
    filePath: string,
    line: number,
    character: number,
    options?: RequestOptions,
  ): Promise<LspLocation[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    const content = await this.prepareDocument(filePath)

    positionToOffset(content, { line, character })
    const result: unknown = await this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    }, options)

    return parseLocations(result)
  }

  async implementations(file: string, line: number, character: number, options?: RequestOptions): Promise<LspLocation[]> {
    const content = await this.prepareDocument(file)
    positionToOffset(content, { line, character })
    return parseLocations(await this.sendRequest("textDocument/implementation", { textDocument: { uri: pathToUri(file) }, position: { line, character } }, options))
  }

  async workspaceSymbols(file: string, query: string, options?: RequestOptions): Promise<WorkspaceSymbol[]> {
    await this.prepareDocument(file)
    return this.queryWorkspaceSymbols(query, options)
  }

  private async queryWorkspaceSymbols(query: string, options?: RequestOptions): Promise<WorkspaceSymbol[]> {
    const result = await this.sendRequest("workspace/symbol", { query }, options)
    if (result === null) return []
    const parsed = z.array(workspaceSymbolSchema).safeParse(result)
    if (!parsed.success) throw new Error("Invalid LSP protocol workspace symbol response")
    const symbols: WorkspaceSymbol[] = []
    for (const symbol of parsed.data) {
      symbols.push(parseWorkspaceSymbol(symbol.location.range ? symbol : await this.sendRequest("workspaceSymbol/resolve", symbol, options)))
    }
    return symbols
  }

  async prepareCallHierarchy(file: string, line: number, character: number, options?: RequestOptions): Promise<HierarchyNode[]> {
    requireCapability("textDocument/prepareCallHierarchy", this.capabilities)
    const content = await this.prepareDocument(file)
    positionToOffset(content, { line, character })
    await this.refreshHierarchyDependencies(options)
    const generation = this.documentSession.generation
    const result = await this.sendRequest("textDocument/prepareCallHierarchy", { textDocument: { uri: pathToUri(file) }, position: { line, character } }, options)
    if (result !== null && !Array.isArray(result)) throw new Error("Invalid LSP protocol call hierarchy response")
    const items = (result ?? []).map(parseHierarchyItem)
    await this.checkHierarchyGeneration(generation)
    return items.map(item => this.hierarchy.put(item, generation))
  }

  /** Native identities and immediate source/config siblings supplement broad watchers.
   * This bounded baseline is not a complete program-file inventory or import graph. */
  private async refreshHierarchyDependencies(options?: RequestOptions): Promise<void> {
    const generation = this.documentSession.generation
    if (this.hierarchyDependenciesGeneration === generation) return
    const symbols = await this.queryWorkspaceSymbols("", options)
    await this.documentSession.noteDependencyDirectories(symbols.map(symbol => symbol.file))
    await this.checkHierarchyGeneration(generation)
    this.hierarchyDependenciesGeneration = generation
  }

  incomingCalls(file: string, itemId: string, options?: RequestOptions): Promise<CallEdge[]> {
    return this.callEdges(file, itemId, "incoming", options)
  }

  outgoingCalls(file: string, itemId: string, options?: RequestOptions): Promise<CallEdge[]> {
    return this.callEdges(file, itemId, "outgoing", options)
  }

  private async checkHierarchyGeneration(generation: number): Promise<void> {
    await this.documentSession.flushFileEvents()
    if (this.documentSession.generation !== generation) throw new Error("Call hierarchy item is invalid after a document change; prepare the hierarchy again")
  }

  private async callEdges(file: string, itemId: string, direction: "incoming" | "outgoing", options?: RequestOptions): Promise<CallEdge[]> {
    await this.documentSession.sync(file, { open: false })
    const generation = this.documentSession.generation
    const item = this.hierarchy.get(itemId, generation)
    const result = await this.sendRequest(`callHierarchy/${direction}Calls`, { item }, options)
    const edgeSchema = direction === "incoming"
      ? z.object({ from: callHierarchyItemSchema, fromRanges: z.array(rangeSchema) }).transform(({ from, fromRanges }) => ({ item: from, fromRanges }))
      : z.object({ to: callHierarchyItemSchema, fromRanges: z.array(rangeSchema) }).transform(({ to, fromRanges }) => ({ item: to, fromRanges }))
    const parsed = z.array(edgeSchema).safeParse(result === null ? [] : result)
    if (!parsed.success) throw new Error("Invalid LSP protocol call hierarchy edges")
    const edges = parsed.data.map(edge => ({ ...edge, item: parseHierarchyItem(edge.item) }))
    await this.checkHierarchyGeneration(generation)
    return edges.map(edge => ({ item: this.hierarchy.put(edge.item, generation), fromFile: uriToPath(direction === "incoming" ? edge.item.uri : item.uri), fromRanges: edge.fromRanges }))
  }

  /**
   * Pull diagnostics for a file
   *
   * @param filePath - Absolute path to the source file.
   */
  async diagnostics(filePath: string, options?: RequestOptions): Promise<LspDiagnostic[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    await this.prepareDocument(filePath)

    const cached = this.diagnosticCache.get(uri)
    const result = await this.sendRequest("textDocument/diagnostic", {
      textDocument: { uri }, ...(cached?.resultId ? { previousResultId: cached.resultId } : {}),
    }, options)
    const parsed = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("full"), resultId: z.string().optional(), items: z.array(diagnosticItemSchema) }),
      z.object({ kind: z.literal("unchanged"), resultId: z.string() }),
    ]).safeParse(result)
    if (!parsed.success) throw new Error("Invalid LSP protocol diagnostic report")
    if (parsed.data.kind === "unchanged") {
      if (!cached) throw new Error("LSP unchanged diagnostic report has no cached result")
      this.diagnosticCache.set(uri, { ...cached, resultId: parsed.data.resultId })
      return cached.items
    }
    const items = parsed.data.items.map(({ code, message, range, severity }) => ({
      line: range.start.line, character: range.start.character,
      endLine: range.end.line, endCharacter: range.end.character,
      severity: SEVERITY_LABELS[severity ?? 1] ?? "error", message, code,
    }))
    this.diagnosticCache.set(uri, { resultId: parsed.data.resultId, items })
    return items
  }

  /**
   * Get code actions for a range, optionally scoped to specific diagnostics
   *
   * @param filePath - Absolute path to the source file.
   * @param range - Source range to inspect.
   * @param range.start - Inclusive start position.
   * @param range.start.line - Zero-based start line.
   * @param range.start.character - Zero-based start character.
   * @param range.end - Exclusive end position.
   * @param range.end.line - Zero-based end line.
   * @param range.end.character - Zero-based end character.
   * @param diagnostics - Diagnostics used to scope available actions.
   */
  async codeActions(
    filePath: string,
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    },
    diagnostics: LspDiagnostic[] = [],
    options?: RequestOptions,
  ): Promise<LspCodeAction[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    const content = await this.prepareDocument(filePath)

    positionToOffset(content, range.start)
    positionToOffset(content, range.end)
    const result: unknown = await this.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context: {
        diagnostics: diagnostics.map(
          ({
            character,
            code,
            endCharacter,
            endLine,
            line,
            message,
            severity,
          }) => ({
            range: {
              start: { line, character },
              end: { line: endLine, character: endCharacter },
            },
            severity: SEVERITY_LABELS.indexOf(severity) || 1,
            message,
            ...(code != null ? { code } : {}),
          }),
        ),
      },
    }, options)

    if (result === null) return []
    if (!Array.isArray(result)) throw new Error("Invalid LSP protocol array response")

    const actions: LspCodeAction[] = []
    for (const item of result) {
      const parsed = z
        .object({
          title: z.string(),
          kind: z.string().optional(),
          diagnostics: z.array(diagnosticItemSchema).optional(),
          edit: z
            .object({
              changes: z.record(z.string(), z.array(textEditSchema)).optional(),
              documentChanges: z.array(z.unknown()).optional(),
            })
            .optional(),
        })
        .safeParse(item)
      if (!parsed.success) throw new Error("Invalid LSP protocol code action")
      if (!parsed.data.edit) continue

      actions.push({
        title: parsed.data.title,
        kind: parsed.data.kind,
        edits: parseWorkspaceEdit(parsed.data.edit),
      })
    }

    return actions
  }

  /**
   * Get a structured outline of all symbols in a file
   *
   * @param filePath - Absolute path to the source file.
   */
  async documentSymbols(filePath: string, options?: RequestOptions): Promise<LspSymbol[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    await this.prepareDocument(filePath)

    const result: unknown = await this.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      options,
    )

    return parseSymbols(result, filePath)
  }

  /**
   * Rename a symbol across the project
   *
   * @param filePath - Absolute path to the source file.
   * @param line - Zero-based source line.
   * @param character - Zero-based character offset.
   * @param newName - Replacement symbol name.
   */
  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
    options?: RequestOptions,
  ): Promise<unknown> {
    if (newName.length === 0) throw new Error("Rename requires a non-empty newName")
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    const content = await this.prepareDocument(filePath)

    positionToOffset(content, { line, character })
    const result: unknown = await this.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line, character },
      newName,
    }, options)

    return result
  }

  /** Invalidate handles immediately, even if post-write synchronization fails. */
  async synchronizeRename(files: string[]): Promise<void> {
    this.hierarchy.clear()
    for (const file of files) await this.documentSession.sync(file)
    await this.documentSession.flushFileEvents()
  }

  /**
   * Get inferred type annotations for a line range
   *
   * @param filePath - Absolute path to the source file.
   * @param startLine - Zero-based inclusive start line.
   * @param endLine - Zero-based exclusive end line.
   */
  async inlayHints(
    filePath: string,
    startLine: number,
    endLine: number,
    options?: RequestOptions,
  ): Promise<LspInlayHint[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    const content = await this.prepareDocument(filePath)

    const result: unknown = await this.sendRequest("textDocument/inlayHint", {
      textDocument: { uri },
      range: inlayRange(content, startLine, endLine),
    }, options)

    if (result === null) return []
    if (!Array.isArray(result)) throw new Error("Invalid LSP protocol array response")

    const hints: LspInlayHint[] = []
    for (const item of result) {
      const parsed = z
        .object({
          position: positionSchema,
          label: z.union([
            z.string(),
            z.array(z.object({ value: z.string() })),
          ]),
          kind: z.number().optional(),
        })
        .safeParse(item)
      if (!parsed.success) throw new Error("Invalid LSP protocol inlay hint")

      const label = parsed.data.label
      hints.push({
        line: parsed.data.position.line,
        character: parsed.data.position.character,
        text:
          typeof label === "string"
            ? label
            : label.map((part) => part.value).join(""),
        kind: INLAY_HINT_KIND_LABELS[parsed.data.kind ?? 0] ?? "unknown",
      })
    }

    return hints
  }

  /**
   * Find all references to a symbol at a position
   *
   * @param filePath - Absolute path to the source file.
   * @param line - Zero-based source line.
   * @param character - Zero-based character offset.
   */
  async references(
    filePath: string,
    line: number,
    character: number,
    options?: RequestOptions,
  ): Promise<LspLocation[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    const content = await this.prepareDocument(filePath)

    positionToOffset(content, { line, character })
    const result: unknown = await this.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    }, options)

    return parseLocations(result)
  }

  /** Close only this owned child, including requests still initializing. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.removeAbortListener()
    this.rejectPending(new Error("LSP client shut down"))
    this.shutdownPromise = (async () => {
      // Leave scheduling room to reap the child within the full 2 s deadline.
      const deadline = setTimeout(() => { this.proc.kill("SIGKILL") }, Math.max(0, this.shutdownTimeoutMs - 50))
      try {
        await this.documentSession.close()
        if (this.alive) {
          try {
            await this.sendRequest("shutdown", null, { timeoutMs: Math.max(1, this.shutdownTimeoutMs - 100) })
            await this.send({ jsonrpc: "2.0", method: "exit" })
          } catch { /* Failed or unresponsive peer is killed at the deadline. */ }
        }
        if (!this.alive) this.proc.kill("SIGKILL")
        await this.closed
      } finally {
        clearTimeout(deadline)
        this.rejectPending(new Error("LSP client shut down"))
        this.buffer = Buffer.alloc(0)
        this.diagnosticCache.clear()
        this.hierarchy.clear()
      }
    })()
    return this.shutdownPromise
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: { symbol: { resolveSupport: { properties: ["location.range"] } }, configuration: true, didChangeConfiguration: { dynamicRegistration: true }, didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
        textDocument: { hover: { contentFormat: ["markdown", "plaintext"] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, diagnostic: { dynamicRegistration: false } },
      },
    }, { signal })
    this.capabilities = z.object({ capabilities: z.record(z.string(), z.unknown()) }).parse(result).capabilities
    const encoding = this.capabilities.positionEncoding
    this.documentSession.setSyncKind(this.capabilities.textDocumentSync ?? 0)
    if (encoding !== undefined && encoding !== "utf-16") throw new Error(`Unsupported LSP position encoding: ${encoding}`)
    await this.send({ jsonrpc: "2.0", method: "initialized", params: {} })
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      request.dispose()
      request.reject(error)
    }
    this.pending.clear()
  }

  private failTransport(error: Error): void {
    this.alive = false
    this.rejectPending(error)
    this.proc.kill("SIGKILL")
    void this.shutdown()
  }

  private snapshot?: { uri: string; content: string }

  /** Composite leased operations reuse one synced disk snapshot. */
  async withDocumentSnapshot<T>(filePath: string, operation: (content: string) => Promise<T>): Promise<T> {
    const content = await this.documentSession.sync(filePath)
    this.snapshot = { uri: pathToUri(filePath), content }
    try { return await operation(content) } finally { this.snapshot = undefined }
  }

  private prepareDocument(filePath: string): Promise<string> {
    const uri = pathToUri(filePath)
    return this.snapshot?.uri === uri ? Promise.resolve(this.snapshot.content) : this.documentSession.sync(filePath)
  }

  /**
   * Send an LSP request and await its response.
   *
   * @param method - LSP method name.
   * @param params - JSON-RPC request parameters.
   */
  private async sendRequest(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (method === 'initialize' || method === 'shutdown') return this.sendRawRequest(method, params, options)
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    const deadline = performance.now() + timeoutMs
    const remainingOptions = (): RequestOptions => {
      if (options.signal?.aborted) throw new Error(`Request "${method}" aborted`)
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error(`Request "${method}" timed out after ${timeoutMs}ms`)
      return { ...options, timeoutMs: remaining }
    }
    const snapshot = this.documentSession.reconciliationSnapshot()
    const result = await this.sendRawRequest(method, params, remainingOptions())
    await this.documentSession.settleReconciliation(snapshot)
    remainingOptions()
    if (!snapshot.pending) return result
    // TS7 can coalesce Created+Changed without refreshing a cached source. The
    // requested read above is the barrier; preserve both original notifications,
    // replay only their permitted Changed, and repeat this pure read at most once.
    this.documentSession.replayReconciliation(snapshot)
    const repeated = await this.sendRawRequest(method, params, remainingOptions())
    await this.documentSession.settleReconciliation(snapshot)
    remainingOptions()
    this.documentSession.completeReconciliation(snapshot)
    return repeated
  }

  private sendRawRequest(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (!this.alive || (this.closing && method !== "shutdown")) return Promise.reject(new Error("LSP client is closed"))
    if (options.signal?.aborted) return Promise.reject(new Error(`Request "${method}" aborted`))
    if (method !== "initialize" && method !== "shutdown") {
      try { requireCapability(method, this.capabilities) } catch (error) { return Promise.reject(error) }
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
      const cancel = (error: Error) => {
        const request = this.pending.get(id)
        if (!request) return
        this.pending.delete(id)
        request.dispose()
        reject(error)
        this.sendNotification("$/cancelRequest", { id })
      }
      const abort = () => cancel(new Error(`Request "${method}" aborted`))
      const timer = setTimeout(() => cancel(new Error(`Request "${method}" timed out after ${timeoutMs}ms`)), timeoutMs)
      const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort) }
      this.pending.set(id, { resolve, reject, dispose })
      options.signal?.addEventListener("abort", abort, { once: true })
      void this.send({ jsonrpc: "2.0", id, method, params }, () => this.pending.has(id)).catch(error => this.failTransport(error))
    })
  }

  private sendNotification(method: string, params: unknown): void {
    void this.send({ jsonrpc: "2.0", method, params }).catch(error => this.failTransport(error))
  }

  private sendResponse(id: number | string, result: unknown): void {
    void this.send({ jsonrpc: "2.0", id, result }).catch(error => this.failTransport(error))
  }

  /** Serial writes resolve after the stream has flushed, respecting backpressure. */
  private send(message: object, shouldSend: () => boolean = () => true): Promise<void> {
    const body = JSON.stringify(message)
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    const write = this.writeQueue.then(() => {
      if (!shouldSend()) return
      if (!this.alive) throw new Error("LSP transport is closed")
      return new Promise<void>((resolve, reject) => {
        this.proc.stdin.write(frame, error => error ? reject(error) : resolve())
      })
    })
    this.writeQueue = write.catch(() => {})
    return write
  }

  /** Parse Content-Length framed messages from the buffer */
  private drainBuffer(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) {
        if (this.buffer.length > 8192) throw new Error("LSP protocol header too large")
        return
      }
      if (headerEnd > 8192) throw new Error("LSP protocol header too large")
      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      const lengths = [...header.matchAll(/^Content-Length: *([0-9]+) *$/gim)]
      if (lengths.length !== 1) throw new Error("Invalid LSP protocol Content-Length")
      const length = Number(lengths[0]![1])
      if (!Number.isSafeInteger(length) || length <= 0 || length > 16 * 1024 * 1024) throw new Error("Invalid LSP protocol body length")
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (this.buffer.length < bodyEnd) return
      let message: unknown
      try { message = JSON.parse(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")) }
      catch { throw new Error("Malformed LSP JSON response") }
      this.buffer = this.buffer.subarray(bodyEnd)
      const parsed = jsonRpcMessageSchema.safeParse(message)
      if (!parsed.success || (!parsed.data.method && (parsed.data.id === undefined || (!Object.hasOwn(message as object, "result") && !parsed.data.error)))) throw new Error("Invalid LSP protocol message")
      this.handleMessage(parsed.data)
    }
  }

  /**
   * Route a parsed JSON-RPC message.
   *
   * @param message - Validated JSON-RPC message from the server.
   */
  private handleMessage(message: z.infer<typeof jsonRpcMessageSchema>): void {
    // Response to one of our requests (numeric id, no method)
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return

      pending.dispose()
      this.pending.delete(message.id)

      if (message.error) {
        pending.reject(
          new Error(
            `LSP error: ${message.error.message} (${message.error.code})`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id != null && message.method) {
      void this.handleServerRequest(message.id, message.method, message.params)
    }
  }
  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (method === "workspace/configuration") this.sendResponse(id, configurationResults(params))
      else if (method === "client/registerCapability") { await this.documentSession.register(params); this.sendResponse(id, null) }
      else if (method === "client/unregisterCapability") { await this.documentSession.unregister(params); this.sendResponse(id, null) }
      else throw new Error(`Unsupported LSP server request: ${method}`)
    } catch (error) {
      void this.send({ jsonrpc: "2.0", id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } }).catch(error => this.failTransport(error))
    }
  }

}

/**
 * Extract text from LSP hover contents. Handles MarkupContent (`{ value }`),
 * plain strings, and arrays of either.
 *
 * @param contents - Raw LSP hover content.
 */
function formatHoverContents(contents: unknown): string {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) {
    if (contents.some(Array.isArray)) throw new Error("Invalid LSP protocol hover contents")
    return contents.map(formatHoverContents).join("\n\n")
  }
  const markup = z.object({ value: z.string() }).safeParse(contents)
  if (markup.success) return markup.data.value
  throw new Error("Invalid LSP protocol hover contents")
}
