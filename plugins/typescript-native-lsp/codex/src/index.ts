#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { LspCodeAction, LspSymbol } from "./lsp-client.ts"
import { TypeScriptPool } from "./pool.ts"
import { resolveTscBinary } from "./resolve-binary.ts"

const pool = new TypeScriptPool(signal => resolveTscBinary({ signal }))

const server = new McpServer({
  name: "typescript-native-lsp",
  version: "1.1.0",
})

server.registerTool(
  "hover",
  {
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    title: "TypeScript Hover",
    description:
      "Get TypeScript type information at a position, plus where it's defined. Returns the same info you'd see hovering in an IDE — resolved types, inferred types, JSDoc — and the definition location.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
      line: z.number().describe("Line number (0-indexed)"),
      character: z.number().describe("Character position (0-indexed)"),
    },
  },
  async ({ file, line, character }, { signal }) => {
    const { hover, definition } = await pool.hoverWithDefinition(
      file,
      line,
      character,
      { signal },
    )

    const parts: string[] = []
    if (hover) parts.push(hover)
    if (definition) {
      parts.push(
        `Defined at: ${definition.file}:${definition.line}:${definition.character}`,
      )
    }

    return {
      content: [
        {
          type: "text" as const,
          text: parts.length > 0 ? parts.join("\n\n") : "(no hover info)",
        },
      ],
    }
  },
)

server.registerTool(
  "diagnostics",
  {
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    title: "TypeScript Diagnostics",
    description:
      "Get TypeScript errors and warnings for a file, along with available quick fixes and their exact text edits. Use this after editing a file to check for type errors.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
    },
  },
  async ({ file }, { signal }) => {
    const { diagnostics, actions } = await pool.diagnosticsWithFixes(file, { signal })

    if (diagnostics.length === 0 && actions.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No errors or warnings." }],
      }
    }

    const parts: string[] = []

    for (const d of diagnostics) {
      parts.push(
        `${d.line}:${d.character} ${d.severity}${d.code != null ? ` TS${d.code}` : ""}: ${d.message}`,
      )
    }

    const fixes = actions.filter((a) => a.kind?.startsWith("quickfix"))
    const sourceActions = actions.filter((a) => a.kind?.startsWith("source"))

    if (fixes.length > 0) {
      parts.push("")
      parts.push("Quick fixes:")
      for (const fix of fixes) {
        parts.push(`  ${fix.title}`)
        for (const edit of fix.edits) {
          parts.push(formatTextEdit(edit))
        }
      }
    }

    if (sourceActions.length > 0) {
      parts.push("")
      parts.push("Source actions:")
      for (const action of sourceActions) {
        parts.push(`  ${action.title}`)
        for (const edit of action.edits) {
          parts.push(formatTextEdit(edit))
        }
      }
    }

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    }
  },
)

server.registerTool(
  "references",
  {
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    title: "TypeScript References",
    description:
      "Find all references to a symbol across the project. Returns a list of file locations where the symbol is used.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
      line: z.number().describe("Line number (0-indexed)"),
      character: z.number().describe("Character position (0-indexed)"),
    },
  },
  async ({ file, line, character }, { signal }) => {
    const locations = await pool.references(file, line, character, { signal })

    if (locations.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No references found." }],
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: locations
            .map((loc) => `${loc.file}:${loc.line}:${loc.character}`)
            .join("\n"),
        },
      ],
    }
  },
)

server.registerTool(
  "outline",
  {
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    title: "TypeScript Outline",
    description:
      "Get a structured outline of all symbols in a file — functions, classes, interfaces, types, variables, etc. with their line numbers. Useful for understanding what's in a file without reading it.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
    },
  },
  async ({ file }, { signal }) => {
    const symbols = await pool.outline(file, { signal })

    if (symbols.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No symbols found." }],
      }
    }

    const lines: string[] = []
    formatSymbolTree(symbols, lines, 0)

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    }
  },
)

server.registerTool(
  "rename",
  {
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    title: "TypeScript Rename",
    description:
      "Rename a symbol across the project. Applies the edits directly to all affected files. Use this instead of manually find-and-replace to ensure type-safe renames.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
      line: z.number().describe("Line number (0-indexed)"),
      character: z.number().describe("Character position (0-indexed)"),
      newName: z.string().min(1).describe("The new name for the symbol"),
    },
  },
  async ({ file, line, character, newName }, { signal }) => {
    const result = await pool.rename(file, line, character, newName, { signal })
    if (result.editCount === 0) return { content: [{ type: "text" as const, text: "No rename edits." }] }
    const parts = result.files.map(({ file, editCount }) => `${file}: ${editCount} edit(s)`)

    return {
      content: [
        {
          type: "text" as const,
          text: `Renamed to "${newName}" — ${result.editCount} edit(s) across ${result.files.length} file(s):\n${parts.join("\n")}`,
        },
      ],
    }
  },
)

server.registerTool(
  "inlay_hints",
  {
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    title: "TypeScript Inlay Hints",
    description:
      "Get inferred type annotations for a line range — variable types, parameter types, return types that TypeScript infers but aren't written in code. Useful for understanding what types TS has inferred.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
      startLine: z.number().describe("Start line (0-indexed, inclusive)"),
      endLine: z.number().describe("End line (0-indexed, exclusive)"),
    },
  },
  async ({ file, startLine, endLine }, { signal }) => {
    const hints = await pool.inlayHints(file, startLine, endLine, { signal })

    if (hints.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No inlay hints." }],
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: hints
            .map((h) => `${h.line}:${h.character} ${h.kind}: ${h.text}`)
            .join("\n"),
        },
      ],
    }
  },
)

const navigationPosition = {
  file: z.string().describe("Absolute path to a file in the target project"),
  line: z.number().int().nonnegative().describe("Line number (0-indexed)"),
  character: z.number().int().nonnegative().describe("UTF-16 character position (0-indexed)"),
}
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const jsonResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })

server.registerTool("definition", {
  title: "TypeScript Definition", description: "Find all definition locations and ranges at a position.", inputSchema: navigationPosition, annotations: readOnly,
}, async ({ file, line, character }, { signal }) => jsonResult(await pool.definition(file, line, character, { signal })))

server.registerTool("workspace_symbols", {
  title: "TypeScript Workspace Symbols", description: "Search symbols across the project selected by file.",
  inputSchema: { file: navigationPosition.file, query: z.string().describe("Symbol search query") }, annotations: readOnly,
}, async ({ file, query }, { signal }) => jsonResult(await pool.workspaceSymbols(file, query, { signal })))

server.registerTool("implementations", {
  title: "TypeScript Implementations", description: "Find all implementation locations and ranges at a position.", inputSchema: navigationPosition, annotations: readOnly,
}, async ({ file, line, character }, { signal }) => jsonResult(await pool.implementations(file, line, character, { signal })))

server.registerTool("prepare_call_hierarchy", {
  title: "TypeScript Prepare Call Hierarchy", description: "Prepare call hierarchy nodes with opaque item IDs for further traversal. IDs expire after relevant file changes or session restart.", inputSchema: navigationPosition, annotations: readOnly,
}, async ({ file, line, character }, { signal }) => jsonResult(await pool.prepareCallHierarchy(file, line, character, { signal })))

const hierarchyInput = { file: navigationPosition.file, item_id: z.string().describe("Opaque item_id from this project's call hierarchy") }
server.registerTool("incoming_calls", {
  title: "TypeScript Incoming Calls", description: "Find callers of a prepared item. fromRanges belong to each caller's fromFile. Use the same project file for traversal.", inputSchema: hierarchyInput, annotations: readOnly,
}, async ({ file, item_id }, { signal }) => jsonResult(await pool.incomingCalls(file, item_id, { signal })))

server.registerTool("outgoing_calls", {
  title: "TypeScript Outgoing Calls", description: "Find callees of a prepared item. fromRanges belong to the original item's fromFile. Use the same project file for traversal.", inputSchema: hierarchyInput, annotations: readOnly,
}, async ({ file, item_id }, { signal }) => jsonResult(await pool.outgoingCalls(file, item_id, { signal })))

/**
 * Recursively format a symbol tree with indentation
 *
 * @param symbols - Symbols at the current tree level.
 * @param lines - Output lines accumulated during traversal.
 * @param depth - Current indentation depth.
 */
function formatSymbolTree(
  symbols: LspSymbol[],
  lines: string[],
  depth: number,
): void {
  for (const sym of symbols) {
    lines.push(
      `${"  ".repeat(depth)}${sym.kind} ${sym.name} (line ${sym.line})`,
    )
    if (sym.children.length > 0) {
      formatSymbolTree(sym.children, lines, depth + 1)
    }
  }
}

/**
 * Format an LSP text edit for CLI output.
 *
 * @param edit - Text edit to render.
 */
function formatTextEdit(edit: LspCodeAction["edits"][number]): string {
  const loc = `    ${edit.file}:${edit.startLine}:${edit.startCharacter}`
  if (edit.newText === "") {
    return `${loc} (delete to ${edit.endLine}:${edit.endCharacter})`
  }
  const preview = edit.newText.includes("\n")
    ? edit.newText.split("\n")[0] + "..."
    : edit.newText
  if (
    edit.startLine === edit.endLine &&
    edit.startCharacter === edit.endCharacter
  ) {
    return `${loc} (insert: ${preview})`
  }
  return `${loc} (replace to ${edit.endLine}:${edit.endCharacter}: ${preview})`
}

/** All EOF, signal and transport-error exits share one cleanup promise. */
let cleanupPromise: Promise<void> | undefined
function cleanup(exitCode = 0): Promise<void> {
  return cleanupPromise ??= pool.shutdown().then(() => { process.exit(exitCode) })
}

process.on("SIGINT", () => { void cleanup() })
process.on("SIGTERM", () => { void cleanup() })
process.stdin.on("end", () => { void cleanup() })
process.stdin.on("close", () => { void cleanup() })
process.stdin.on("error", () => { void cleanup(1) })
process.stdout.on("error", () => { void cleanup(1) })
server.server.onclose = () => { void cleanup() }
server.server.onerror = () => { void cleanup(1) }

try {
  await server.connect(new StdioServerTransport())
} catch {
  await cleanup(1)
}
