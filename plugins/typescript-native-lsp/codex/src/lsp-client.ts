import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

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

/** Shared LSP position shape. */
const positionSchema = z.object({ line: z.number(), character: z.number() })
const rangeSchema = z.object({ start: positionSchema, end: positionSchema })

/** Location shape returned by definition and reference requests. */
const locationSchema = z.object({ uri: z.string(), range: rangeSchema })

/** Diagnostic item shape returned by TypeScript. */
const diagnosticItemSchema = z.object({
  range: rangeSchema,
  severity: z.number().optional(),
  code: z.union([z.number(), z.string()]).optional(),
  source: z.string().optional(),
  message: z.string(),
})

/** Text-edit shape shared by code actions and workspace edits. */
const textEditSchema = z.object({ range: rangeSchema, newText: z.string() })

export interface LspLocation {
  file: string
  line: number
  character: number
}

const SEVERITY_LABELS = ["", "error", "warning", "info", "hint"] as const

export interface LspDiagnostic {
  line: number
  character: number
  endLine: number
  endCharacter: number
  severity: (typeof SEVERITY_LABELS)[number]
  message: string
  code?: number | string
}

export interface LspTextEdit {
  file: string
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  newText: string
}

export interface LspCodeAction {
  title: string
  kind?: string
  edits: LspTextEdit[]
}

const SYMBOL_KIND_LABELS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  22: "enum member",
  26: "type parameter",
}

export interface LspSymbol {
  name: string
  kind: string
  line: number
  character: number
  children: LspSymbol[]
}

const INLAY_HINT_KIND_LABELS: Record<number, string> = {
  1: "type",
  2: "parameter",
}

export interface LspInlayHint {
  line: number
  character: number
  text: string
  kind: string
}

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

interface DocumentState {
  version: number
  content: string
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
  private documents = new Map<string, DocumentState>()
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
    const projectRoot = fileURLToPath(rootUri)
    this.proc = options.spawnProcess
      ? options.spawnProcess(binaryPath, projectRoot)
      : spawn(binaryPath, ["--lsp", "--stdio"], { cwd: projectRoot, stdio: "pipe", shell: false })
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
    await this.ensureDocumentOpen(filePath, uri)

    const result: unknown = await this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    }, options)

    const parsed = z.object({ contents: z.unknown() }).safeParse(result)
    if (!parsed.success) return null

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
    await this.ensureDocumentOpen(filePath, uri)

    const result: unknown = await this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    }, options)

    return parseLocations(result)
  }

  /**
   * Pull diagnostics for a file
   *
   * @param filePath - Absolute path to the source file.
   */
  async diagnostics(filePath: string, options?: RequestOptions): Promise<LspDiagnostic[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    await this.ensureDocumentOpen(filePath, uri)

    const result: unknown = await this.sendRequest("textDocument/diagnostic", {
      textDocument: { uri },
    }, options)

    const parsed = z
      .object({
        kind: z.string(),
        items: z.array(diagnosticItemSchema),
      })
      .safeParse(result)
    if (!parsed.success) return []

    return parsed.data.items.map(({ code, message, range, severity }) => ({
      line: range.start.line,
      character: range.start.character,
      endLine: range.end.line,
      endCharacter: range.end.character,
      severity: SEVERITY_LABELS[severity ?? 1] ?? "error",
      message,
      code,
    }))
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
    await this.ensureDocumentOpen(filePath, uri)

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

    if (!Array.isArray(result)) return []

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
            })
            .optional(),
        })
        .safeParse(item)
      if (!parsed.success || !parsed.data.edit) continue

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
    await this.ensureDocumentOpen(filePath, uri)

    const result: unknown = await this.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      options,
    )

    if (!Array.isArray(result)) return []

    return buildSymbolTree(result)
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
  ): Promise<LspTextEdit[]> {
    if (!this.isAlive) throw new Error("LSP client is not alive")

    const uri = pathToUri(filePath)
    await this.ensureDocumentOpen(filePath, uri)

    const result: unknown = await this.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line, character },
      newName,
    }, options)

    return parseWorkspaceEdit(result)
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
    await this.ensureDocumentOpen(filePath, uri)

    const result: unknown = await this.sendRequest("textDocument/inlayHint", {
      textDocument: { uri },
      range: {
        start: { line: startLine, character: 0 },
        end: { line: endLine, character: 0 },
      },
    }, options)

    if (!Array.isArray(result)) return []

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
      if (!parsed.success) continue

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
    await this.ensureDocumentOpen(filePath, uri)

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
        this.documents.clear()
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
        textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } },
      },
    }, { signal })
    const encoding = z.object({ capabilities: z.object({ positionEncoding: z.string().optional() }) }).parse(result).capabilities.positionEncoding
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

  /**
   * Re-read all previously opened documents from disk and push changes to
   * TypeScript. This ensures that edits to imported/dependency files are picked
   * up before we query a file that depends on them.
   */
  private async refreshOpenDocuments(): Promise<void> {
    for (const [uri, state] of this.documents) {
      let content: string
      try {
        content = await readFile(uriToPath(uri), "utf-8")
      } catch {
        continue
      }
      if (content !== state.content) {
        const version = state.version + 1
        this.sendNotification("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text: content }],
        })
        this.documents.set(uri, { version, content })
      }
    }
  }

  /**
   * Open a document in the LSP if needed, or update it if contents changed
   *
   * @param filePath - Absolute path to the source file.
   * @param uri - LSP document URI for the file.
   */
  private async ensureDocumentOpen(
    filePath: string,
    uri: string,
  ): Promise<void> {
    await this.refreshOpenDocuments()

    const content = await readFile(filePath, "utf-8")
    const existing = this.documents.get(uri)

    if (!existing) {
      this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: getLanguageId(filePath),
          version: 1,
          text: content,
        },
      })
      this.documents.set(uri, { version: 1, content })
      return
    }

    if (existing.content !== content) {
      const version = existing.version + 1
      this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      })
      this.documents.set(uri, { version, content })
    }
  }

  /**
   * Send an LSP request and await its response.
   *
   * @param method - LSP method name.
   * @param params - JSON-RPC request parameters.
   */
  private sendRequest(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (!this.alive || (this.closing && method !== "shutdown")) return Promise.reject(new Error("LSP client is closed"))
    if (options.signal?.aborted) return Promise.reject(new Error(`Request "${method}" aborted`))
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

    // Server-initiated request — auto-acknowledge
    if (message.id != null && message.method) {
      this.sendResponse(message.id, null)
    }
  }
}

/**
 * Convert a file path to an LSP file URI.
 *
 * @param filePath - Absolute path to convert.
 */
function pathToUri(filePath: string): string {
  return `file://${filePath}`
}

/**
 * Convert an LSP file URI to a file path.
 *
 * @param uri - File URI to convert.
 */
function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, "")
}

/**
 * Parse Location[] or LocationLink[] from an LSP response into LspLocation[].
 * Handles single objects, arrays, and null.
 *
 * @param result - Raw LSP definition response.
 */
function parseLocations(result: unknown): LspLocation[] {
  if (result == null) return []
  const locations: LspLocation[] = []

  for (const item of Array.isArray(result) ? result : [result]) {
    const loc = locationSchema.safeParse(item)
    if (loc.success) {
      locations.push({
        file: uriToPath(loc.data.uri),
        line: loc.data.range.start.line,
        character: loc.data.range.start.character,
      })
      continue
    }

    const link = z
      .object({
        targetUri: z.string(),
        targetRange: rangeSchema,
        targetSelectionRange: rangeSchema.optional(),
      })
      .safeParse(item)
    if (link.success) {
      const range = link.data.targetSelectionRange ?? link.data.targetRange
      locations.push({
        file: uriToPath(link.data.targetUri),
        line: range.start.line,
        character: range.start.character,
      })
    }
  }

  return locations
}

/**
 * Build a symbol tree from flat SymbolInformation[]. Uses containerName to
 * reconstruct parent-child relationships.
 *
 * @param items - Raw LSP symbol information records.
 */
function buildSymbolTree(items: unknown[]): LspSymbol[] {
  const flat: Array<{ symbol: LspSymbol; containerName?: string }> = []

  for (const item of items) {
    const parsed = z
      .object({
        name: z.string(),
        kind: z.number(),
        containerName: z.string().optional(),
        location: locationSchema,
      })
      .safeParse(item)
    if (!parsed.success) continue

    flat.push({
      symbol: {
        name: parsed.data.name,
        kind:
          SYMBOL_KIND_LABELS[parsed.data.kind] ?? `kind(${parsed.data.kind})`,
        line: parsed.data.location.range.start.line,
        character: parsed.data.location.range.start.character,
        children: [],
      },
      containerName: parsed.data.containerName,
    })
  }

  const byName = new Map<string, LspSymbol>()
  for (const entry of flat) {
    if (!byName.has(entry.symbol.name)) {
      byName.set(entry.symbol.name, entry.symbol)
    }
  }

  const roots: LspSymbol[] = []
  for (const entry of flat) {
    const parent = entry.containerName
      ? byName.get(entry.containerName)
      : undefined
    if (parent) {
      parent.children.push(entry.symbol)
    } else {
      roots.push(entry.symbol)
    }
  }

  return roots
}

/**
 * Parse a WorkspaceEdit into flat LspTextEdit[]
 *
 * @param result - Raw LSP workspace edit.
 */
function parseWorkspaceEdit(result: unknown): LspTextEdit[] {
  const parsed = z
    .object({
      changes: z.record(z.string(), z.array(textEditSchema)).optional(),
    })
    .safeParse(result)
  if (!parsed.success || !parsed.data.changes) return []

  const edits: LspTextEdit[] = []
  for (const [editUri, textEdits] of Object.entries(parsed.data.changes)) {
    for (const te of textEdits) {
      edits.push({
        file: uriToPath(editUri),
        startLine: te.range.start.line,
        startCharacter: te.range.start.character,
        endLine: te.range.end.line,
        endCharacter: te.range.end.character,
        newText: te.newText,
      })
    }
  }
  return edits
}

/**
 * Return the LSP language identifier for a source file.
 *
 * @param filePath - Source file path.
 */
function getLanguageId(filePath: string): string {
  switch (extname(filePath)) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript"
    case ".tsx":
      return "typescriptreact"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript"
    case ".jsx":
      return "javascriptreact"
    default:
      return "typescript"
  }
}

/**
 * Extract text from LSP hover contents. Handles MarkupContent (`{ value }`),
 * plain strings, and arrays of either.
 *
 * @param contents - Raw LSP hover content.
 */
function formatHoverContents(contents: unknown): string | null {
  const str = z.string().safeParse(contents)
  if (str.success) return str.data

  if (Array.isArray(contents)) {
    const parts = contents.map(formatHoverContents).filter(Boolean)
    return parts.length > 0 ? parts.join("\n\n") : null
  }

  const markup = z.object({ value: z.string() }).safeParse(contents)
  if (markup.success) return markup.data.value

  return null
}
