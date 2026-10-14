import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  type LspCodeAction,
  type LspDiagnostic,
  type LspInlayHint,
  type LspLocation,
  type LspSymbol,
  type LspTextEdit,
  LspClient,
} from "./lsp-client.ts"

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

interface PoolEntry {
  client: LspClient
  idleTimer: ReturnType<typeof setTimeout>
}

/**
 * Manages a pool of TypeScript LSP instances, one per project root.
 * Automatically discovers the project root from file paths by walking up to the
 * nearest tsconfig.json. Instances are kept warm and shut down after a
 * configurable idle timeout.
 */
export class TypeScriptPool {
  private entries = new Map<string, PoolEntry>()

  /**
   * Create an LSP client pool.
   *
   * @param binaryPath - Absolute path to the native tsc binary.
   * @param idleTimeoutMs - Time before an inactive client is shut down.
   */
  constructor(
    private binaryPath: string,
    private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  ) {}

  /**
   * Get hover info + definition location in one call
   *
   * @param filePath - Absolute path to the source file.
   * @param line - Zero-based source line.
   * @param character - Zero-based character offset.
   */
  async hoverWithDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<{ hover: string | null; definition: LspLocation | null }> {
    const client = await this.getClient(filePath)
    const [hover, definitions] = await Promise.all([
      client.hover(filePath, line, character),
      client.definition(filePath, line, character),
    ])
    return { hover, definition: definitions[0] ?? null }
  }

  /**
   * Get diagnostics for a file with available fixes for each error
   *
   * @param filePath - Absolute path to the source file.
   */
  async diagnosticsWithFixes(
    filePath: string,
  ): Promise<{ diagnostics: LspDiagnostic[]; actions: LspCodeAction[] }> {
    const client = await this.getClient(filePath)
    const diagnostics = await client.diagnostics(filePath)

    return {
      diagnostics,
      actions: await client.codeActions(
        filePath,
        {
          start: { line: 0, character: 0 },
          end: { line: 1_000_000, character: 0 },
        },
        diagnostics,
      ),
    }
  }

  /**
   * Find all references to a symbol
   *
   * @param filePath - Absolute path to the source file.
   * @param line - Zero-based source line.
   * @param character - Zero-based character offset.
   */
  async references(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    return (await this.getClient(filePath)).references(
      filePath,
      line,
      character,
    )
  }

  /**
   * Get a structured outline of all symbols in a file
   *
   * @param filePath - Absolute path to the source file.
   */
  async outline(filePath: string): Promise<LspSymbol[]> {
    return (await this.getClient(filePath)).documentSymbols(filePath)
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
  ): Promise<LspTextEdit[]> {
    return (await this.getClient(filePath)).rename(
      filePath,
      line,
      character,
      newName,
    )
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
  ): Promise<LspInlayHint[]> {
    return (await this.getClient(filePath)).inlayHints(
      filePath,
      startLine,
      endLine,
    )
  }

  /** Shut down all active LSP instances */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(({ client, idleTimer }) => {
        clearTimeout(idleTimer)
        return client.shutdown()
      }),
    )
    this.entries.clear()
  }

  /**
   * Get or create the client for a file's project.
   *
   * @param filePath - Absolute path used to locate the project.
   */
  private async getClient(filePath: string): Promise<LspClient> {
    const projectRoot = findProjectRoot(filePath)

    const existing = this.entries.get(projectRoot)
    if (existing?.client.isAlive) {
      this.resetIdleTimer(projectRoot, existing)
      return existing.client
    }

    if (existing) {
      clearTimeout(existing.idleTimer)
      this.entries.delete(projectRoot)
    }

    const client = await LspClient.create(
      this.binaryPath,
      `file://${projectRoot}`,
    )
    const entry: PoolEntry = {
      client,
      idleTimer: this.startIdleTimer(projectRoot),
    }
    this.entries.set(projectRoot, entry)
    return client
  }

  /**
   * Schedule an idle client for shutdown.
   *
   * @param projectRoot - Absolute path to the client's project root.
   */
  private startIdleTimer(projectRoot: string): ReturnType<typeof setTimeout> {
    return setTimeout(async () => {
      const entry = this.entries.get(projectRoot)
      if (entry) {
        await entry.client.shutdown()
        this.entries.delete(projectRoot)
      }
    }, this.idleTimeoutMs)
  }

  /**
   * Restart a client's idle shutdown timer.
   *
   * @param projectRoot - Absolute path to the client's project root.
   * @param entry - Pool entry whose timer should be restarted.
   */
  private resetIdleTimer(projectRoot: string, entry: PoolEntry): void {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = this.startIdleTimer(projectRoot)
  }
}

/**
 * Walk up from a file path to find the nearest tsconfig.json
 *
 * @param filePath - Absolute path used to start the search.
 */
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
