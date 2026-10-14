#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { LspCodeAction, LspSymbol, LspTextEdit } from "./lsp-client.ts"
import { TypeScriptPool } from "./pool.ts"
import { resolveTscBinary } from "./resolve-binary.ts"

const pool = new TypeScriptPool(resolveTscBinary())

const server = new McpServer({
  name: "ts-hover",
  version: "0.3.0",
})

server.registerTool(
  "hover",
  {
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
  async ({ file, line, character }) => {
    const { hover, definition } = await pool.hoverWithDefinition(
      file,
      line,
      character,
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
    title: "TypeScript Diagnostics",
    description:
      "Get TypeScript errors and warnings for a file, along with available quick fixes and their exact text edits. Use this after editing a file to check for type errors.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
    },
  },
  async ({ file }) => {
    const { diagnostics, actions } = await pool.diagnosticsWithFixes(file)

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
  async ({ file, line, character }) => {
    const locations = await pool.references(file, line, character)

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
    title: "TypeScript Outline",
    description:
      "Get a structured outline of all symbols in a file — functions, classes, interfaces, types, variables, etc. with their line numbers. Useful for understanding what's in a file without reading it.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
    },
  },
  async ({ file }) => {
    const symbols = await pool.outline(file)

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
    title: "TypeScript Rename",
    description:
      "Rename a symbol across the project. Applies the edits directly to all affected files. Use this instead of manually find-and-replace to ensure type-safe renames.",
    inputSchema: {
      file: z
        .string()
        .describe("Absolute path to the TypeScript/JavaScript file"),
      line: z.number().describe("Line number (0-indexed)"),
      character: z.number().describe("Character position (0-indexed)"),
      newName: z.string().describe("The new name for the symbol"),
    },
  },
  async ({ file, line, character, newName }) => {
    const edits = await pool.rename(file, line, character, newName)

    if (edits.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No rename edits." }],
      }
    }

    const byFile = new Map<string, LspTextEdit[]>()
    for (const edit of edits) {
      const group = byFile.get(edit.file) ?? []
      group.push(edit)
      byFile.set(edit.file, group)
    }

    const parts: string[] = []
    for (const [filePath, fileEdits] of byFile) {
      await applyEdits(filePath, fileEdits)
      parts.push(`${filePath}: ${fileEdits.length} edit(s)`)
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Renamed to "${newName}" — ${edits.length} edit(s) across ${byFile.size} file(s):\n${parts.join("\n")}`,
        },
      ],
    }
  },
)

server.registerTool(
  "inlay_hints",
  {
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
  async ({ file, startLine, endLine }) => {
    const hints = await pool.inlayHints(file, startLine, endLine)

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

/**
 * Apply LSP text edits to a file. Edits are sorted bottom-to-top so earlier
 * positions aren't shifted by later replacements.
 *
 * @param filePath - Absolute path to the file being edited.
 * @param edits - LSP edits to apply.
 */
async function applyEdits(filePath: string, edits: LspTextEdit[]) {
  const lines = (await readFile(filePath, "utf-8")).split("\n")

  for (const edit of [...edits].toSorted((a, b) => {
    if (a.startLine !== b.startLine) return b.startLine - a.startLine
    return b.startCharacter - a.startCharacter
  })) {
    lines.splice(
      edit.startLine,
      edit.endLine - edit.startLine + 1,
      ...(
        (lines[edit.startLine] ?? "").slice(0, edit.startCharacter) +
        edit.newText +
        (lines[edit.endLine] ?? "").slice(edit.endCharacter)
      ).split("\n"),
    )
  }

  await writeFile(filePath, lines.join("\n"))
}

/** Shut down the client pool before exiting. */
async function cleanup() {
  await pool.shutdown()
  process.exit(0)
}

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)

await server.connect(new StdioServerTransport())
