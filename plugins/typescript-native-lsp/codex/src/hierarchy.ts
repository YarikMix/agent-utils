import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { uriToPath } from './files.ts'
import { rangeSchema, type Range } from './protocol.ts'

export interface CallHierarchyItem {
  name: string
  kind: number
  uri: string
  range: Range
  selectionRange: Range
  detail?: string
  tags?: number[]
  data?: unknown
}
export interface HierarchyNode { item_id: string; name: string; kind: number; file: string; range: Range; selectionRange: Range; detail?: string }
export interface CallEdge { item: HierarchyNode; fromFile: string; fromRanges: Range[] }

export const callHierarchyItemSchema = z.object({ name: z.string(), kind: z.number().int().min(1).max(26), uri: z.string(), range: rangeSchema, selectionRange: rangeSchema, detail: z.string().optional(), tags: z.array(z.number().int()).optional(), data: z.unknown().optional() }).passthrough()
export function parseHierarchyItem(value: unknown): CallHierarchyItem {
  const parsed = callHierarchyItemSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid LSP protocol call hierarchy item')
  uriToPath(parsed.data.uri)
  return parsed.data
}

/** Original native items are only reachable through session-local unguessable IDs. */
export class HierarchyStore {
  private items = new Map<string, CallHierarchyItem>()
  private generation?: number

  private refresh(generation: number): void {
    if (this.generation !== generation) { this.items.clear(); this.generation = generation }
  }

  put(item: CallHierarchyItem, generation: number): HierarchyNode {
    this.refresh(generation)
    const original = structuredClone(parseHierarchyItem(item))
    const item_id = randomUUID()
    this.items.set(item_id, original)
    return { item_id, name: original.name, kind: original.kind, file: uriToPath(original.uri), range: structuredClone(original.range), selectionRange: structuredClone(original.selectionRange), ...(original.detail === undefined ? {} : { detail: original.detail }) }
  }

  get(itemId: string, generation: number): CallHierarchyItem {
    this.refresh(generation)
    const item = this.items.get(itemId)
    if (!item) throw new Error('Call hierarchy item ID is invalid or expired; prepare the hierarchy again')
    return structuredClone(item)
  }

  clear(): void { this.items.clear(); this.generation = undefined }
}
