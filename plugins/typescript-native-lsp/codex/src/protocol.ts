import { z } from "zod"
import { uriToPath } from "./files.ts"

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export const positionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() })
export const rangeSchema = z.object({ start: positionSchema, end: positionSchema }).refine(r => r.start.line < r.end.line || (r.start.line === r.end.line && r.start.character <= r.end.character), "Invalid range")
export const locationSchema = z.object({ uri: z.string(), range: rangeSchema })
export const diagnosticItemSchema = z.object({ range: rangeSchema, severity: z.number().int().min(1).max(4).optional(), code: z.union([z.number(), z.string()]).optional(), source: z.string().optional(), message: z.string() })
export const textEditSchema = z.object({ range: rangeSchema, newText: z.string() })

export interface LspLocation {
  file: string
  line: number
  character: number
  range: Range
  targetRange?: Range
  targetSelectionRange?: Range
  originSelectionRange?: Range
}

export const SEVERITY_LABELS = ["", "error", "warning", "info", "hint"] as const

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

export const SYMBOL_KIND_LABELS: Record<number, string> = {
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

export const INLAY_HINT_KIND_LABELS: Record<number, string> = {
  1: "type",
  2: "parameter",
}

export interface LspInlayHint {
  line: number
  character: number
  text: string
  kind: string
}

export function parseLocations(value: unknown): LspLocation[] {
  if (value === null) return []
  return (Array.isArray(value) ? value : [value]).map(item => {
    const loc = locationSchema.safeParse(item)
    if (loc.success) return { file: uriToPath(loc.data.uri), ...loc.data.range.start, range: loc.data.range }
    const link = z.object({ targetUri: z.string(), targetRange: rangeSchema, targetSelectionRange: rangeSchema.optional(), originSelectionRange: rangeSchema.optional() }).safeParse(item)
    if (!link.success) throw new Error('Invalid LSP protocol location response')
    const range = link.data.targetSelectionRange ?? link.data.targetRange
    return { file: uriToPath(link.data.targetUri), ...range.start, range, targetRange: link.data.targetRange, ...(link.data.targetSelectionRange ? { targetSelectionRange: link.data.targetSelectionRange } : {}), ...(link.data.originSelectionRange ? { originSelectionRange: link.data.originSelectionRange } : {}) }
  })
}

export function parseSymbols(value: unknown, file: string): LspSymbol[] {
  if (value === null) return []
  if (!Array.isArray(value)) throw new Error('Invalid LSP protocol symbol response')
  const seen = new WeakSet<object>()
  const parseNested = (item: unknown): LspSymbol => {
    const parsed = z.object({ name: z.string(), kind: z.number().int(), range: rangeSchema, selectionRange: rangeSchema, children: z.array(z.unknown()).optional() }).safeParse(item)
    if (!parsed.success || seen.has(item as object)) throw new Error('Invalid or cyclic LSP protocol document symbol')
    seen.add(item as object)
    return { name: parsed.data.name, kind: SYMBOL_KIND_LABELS[parsed.data.kind] ?? `kind(${parsed.data.kind})`, ...parsed.data.selectionRange.start, children: (parsed.data.children ?? []).map(parseNested) }
  }
  if (value.some(item => item && typeof item === 'object' && 'selectionRange' in item)) return value.map(parseNested)
  const entries = value.map(item => {
    const parsed = z.object({ name: z.string(), kind: z.number().int(), location: locationSchema, containerName: z.string().optional() }).safeParse(item)
    if (!parsed.success) throw new Error('Invalid LSP protocol symbol information')
    const data = parsed.data
    return { ...data, file: uriToPath(data.location.uri), symbol: { name: data.name, kind: SYMBOL_KIND_LABELS[data.kind] ?? `kind(${data.kind})`, ...data.location.range.start, children: [] } as LspSymbol }
  })
  const roots: LspSymbol[] = []
  const parents = new Map<LspSymbol, LspSymbol>()
  for (const entry of entries) {
    const candidates = entries.filter(parent => parent !== entry && parent.name === entry.containerName && parent.file === entry.file)
    const parent = candidates.length === 1 ? candidates[0] : undefined
    let ancestor = parent?.symbol
    const visited = new Set<LspSymbol>([entry.symbol])
    while (ancestor && !visited.has(ancestor)) { visited.add(ancestor); ancestor = parents.get(ancestor) }
    if (entry.file === file && parent && !ancestor) { parent.symbol.children.push(entry.symbol); parents.set(entry.symbol, parent.symbol) }
    else roots.push(entry.symbol)
  }
  return roots
}

const CAPABILITIES: Record<string, string> = {
  'textDocument/hover': 'hoverProvider', 'textDocument/definition': 'definitionProvider',
  'textDocument/diagnostic': 'diagnosticProvider', 'textDocument/codeAction': 'codeActionProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider', 'textDocument/rename': 'renameProvider',
  'textDocument/inlayHint': 'inlayHintProvider', 'textDocument/references': 'referencesProvider',
  'workspace/symbol': 'workspaceSymbolProvider', 'textDocument/implementation': 'implementationProvider',
  'textDocument/prepareCallHierarchy': 'callHierarchyProvider', 'callHierarchy/incomingCalls': 'callHierarchyProvider', 'callHierarchy/outgoingCalls': 'callHierarchyProvider',
}
export function requireCapability(method: string, capabilities: Record<string, unknown>): void {
  if (method === 'workspaceSymbol/resolve') {
    const provider = capabilities.workspaceSymbolProvider
    if (!provider || typeof provider !== 'object' || !('resolveProvider' in provider) || provider.resolveProvider !== true) throw new Error('Missing LSP capability for workspaceSymbol/resolve')
    return
  }
  const key = CAPABILITIES[method]
  const value = key && capabilities[key]
  if (!key || !(value === true || (value !== null && typeof value === 'object' && !Array.isArray(value)))) throw new Error(`Missing LSP capability for ${method}`)
}

/** Pinned TS7 consumes nested VS Code configuration, in the requested order. */
export function configurationResults(params: unknown): unknown[] {
  const parsed = z.object({ items: z.array(z.object({ section: z.string().optional(), scopeUri: z.string().optional() })) }).parse(params)
  return parsed.items.map(({ section }) => {
    if (section === 'editor') return { tabSize: 2, insertSpaces: true }
    if (!['js/ts', 'typescript', 'javascript'].includes(section ?? '')) return null
    return { inlayHints: { parameterNames: { enabled: 'all' }, variableTypes: { enabled: true }, functionLikeReturnTypes: { enabled: true } }, tsserver: { automaticTypeAcquisition: { enabled: false } }, disableAutomaticTypeAcquisition: true }
  })
}

export function parseWorkspaceEdit(value: unknown): LspTextEdit[] {
  if (value === null) return []
  const parsed = z.object({ changes: z.record(z.string(), z.array(textEditSchema)).optional(), documentChanges: z.array(z.object({ textDocument: z.object({ uri: z.string(), version: z.number().nullable().optional() }), edits: z.array(textEditSchema) })).optional() }).safeParse(value)
  if (!parsed.success) throw new Error('Invalid LSP protocol workspace edit')
  const groups = [...Object.entries(parsed.data.changes ?? {}), ...(parsed.data.documentChanges ?? []).map(change => [change.textDocument.uri, change.edits] as const)]
  return groups.flatMap(([uri, edits]) => edits.map(edit => ({ file: uriToPath(uri), startLine: edit.range.start.line, startCharacter: edit.range.start.character, endLine: edit.range.end.line, endCharacter: edit.range.end.character, newText: edit.newText })))
}

export interface WorkspaceSymbol { name: string; kind: string; file: string; line: number; character: number }
export const workspaceSymbolSchema = z.object({ name: z.string(), kind: z.number().int().min(1).max(26), location: z.object({ uri: z.string(), range: rangeSchema.optional() }), data: z.unknown().optional() }).passthrough()

export function parseWorkspaceSymbol(value: unknown): WorkspaceSymbol {
  const parsed = workspaceSymbolSchema.safeParse(value)
  if (!parsed.success || !parsed.data.location.range) throw new Error('Invalid LSP protocol workspace symbol range')
  const { name, kind, location } = parsed.data
  return { name, kind: SYMBOL_KIND_LABELS[kind] ?? `kind(${kind})`, file: uriToPath(location.uri), ...location.range!.start }
}
