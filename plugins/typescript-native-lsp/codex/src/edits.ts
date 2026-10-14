import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { DocumentSession } from './documents.ts'
import { assertProjectWritePath, pathToUri, positionToOffset, uriToPath } from './files.ts'
import { renameWorkspaceEditSchema } from './protocol.ts'

export type EditIO = Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'rm' | 'stat' | 'access' | 'realpath' | 'chmod'>
export interface RenameResult { editCount: number; files: Array<{ file: string; editCount: number }> }
interface PreparedFile {
  file: string; source: string; before: Buffer; after: Buffer; mode: number; editCount: number
}
export interface PreparedWorkspaceEdit { root: string; files: PreparedFile[] }

/** Validate the complete response before any mutation. BOM is part of the opened LSP text. */
export async function prepareWorkspaceEdit(root: string, value: unknown, documents: DocumentSession, io: EditIO = fs): Promise<PreparedWorkspaceEdit> {
  const parsed = renameWorkspaceEditSchema.safeParse(value === null ? {} : value)
  if (!parsed.success) throw new Error(`Invalid workspace edit: ${parsed.error.message}`)
  const groups = parsed.data.changes !== undefined
    ? Object.entries(parsed.data.changes).map(([uri, edits]) => ({ uri, edits, version: null }))
    : (parsed.data.documentChanges ?? []).map(({ textDocument, edits }) => ({ ...textDocument, edits }))
  const files: PreparedFile[] = []; const seen = new Set<string>()
  const canonicalRoot = await io.realpath(root)
  for (const { uri, edits, version } of groups) {
    const source = uriToPath(uri)
    const file = await assertProjectWritePath(root, source, io)
    if (seen.has(file)) throw new Error(`Duplicate workspace edit file: ${file}`)
    seen.add(file)
    const openedVersion = documents.getVersion(uri)
    if (version !== null && version !== openedVersion) throw new Error(`Workspace edit version mismatch: ${file}`)
    const stat = await io.stat(file)
    if (!stat.isFile()) throw new Error(`Workspace edit requires a regular file: ${file}`)
    await io.access(file, constants.R_OK | constants.W_OK)
    await io.access(dirname(file), constants.W_OK)
    const before = await io.readFile(file)
    const text = before.toString('utf8')
    if (!Buffer.from(text).equals(before)) throw new Error(`Workspace edit requires valid UTF-8: ${file}`)
    // A versionless response must not silently use a newer disk snapshot either.
    for (const candidate of new Set([uri, pathToUri(file)])) {
      const opened = documents.getText(candidate)
      if (opened !== undefined && opened !== text) throw new Error(`Workspace edit snapshot changed: ${file}`)
    }
    const offsets = edits.map(edit => ({ start: positionToOffset(text, edit.range.start), end: positionToOffset(text, edit.range.end), newText: edit.newText })).sort((a, b) => a.start - b.start || a.end - b.end)
    for (let i = 0; i < offsets.length; i++) {
      const current = offsets[i]!; const previous = offsets[i - 1]
      if (previous && (previous.start === current.start || previous.end > current.start)) throw new Error(`Overlapping or ambiguous workspace edits: ${file}`)
      for (const offset of [current.start, current.end]) {
        if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')) throw new Error(`Invalid position inside UTF-16 surrogate pair: ${file}`)
      }
      if (Buffer.from(current.newText).toString('utf8') !== current.newText) throw new Error(`Invalid workspace edit Unicode: ${file}`)
    }
    let after = text
    for (const edit of offsets.toReversed()) after = after.slice(0, edit.start) + edit.newText + after.slice(edit.end)
    if (edits.length) files.push({ source, file, before, after: Buffer.from(after), mode: stat.mode & 0o7777, editCount: edits.length })
  }
  return { root: canonicalRoot, files }
}

/** Compare paths and bytes immediately before each replace, including rollback. */
async function unchanged(prepared: PreparedWorkspaceEdit, file: PreparedFile, expected: Buffer, io: EditIO): Promise<void> {
  if (await assertProjectWritePath(prepared.root, file.source, io) !== file.file || await io.realpath(file.file) !== file.file) throw new Error(`Rename path changed: ${file.file}`)
  const stat = await io.stat(file.file)
  if (!stat.isFile() || (stat.mode & 0o7777) !== file.mode || !(await io.readFile(file.file)).equals(expected)) throw new Error(`Rename snapshot changed: ${file.file}`)
}

/** Best-effort rollback, never intentional overwrite of an observed external change. */
export async function applyWorkspaceEdit(prepared: PreparedWorkspaceEdit, io: EditIO = fs): Promise<RenameResult> {
  const artifacts = new Set<string>(); const staged = new Map<PreparedFile, string>(); const replaced: PreparedFile[] = []
  const restored: string[] = []; const changed: string[] = []; const issues: string[] = []
  let failure: unknown
  const stage = async (file: PreparedFile, bytes: Buffer): Promise<string> => {
    const temp = join(dirname(file.file), `.ts-rename-${randomUUID()}.tmp`)
    // Unique exclusive creation; record before writing so partial writes are cleaned.
    artifacts.add(temp)
    try { await io.writeFile(temp, bytes, { flag: 'wx', mode: file.mode, flush: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') artifacts.delete(temp)
      throw error
    }
    await io.chmod(temp, file.mode)
    return temp
  }
  try {
    for (const file of prepared.files) await unchanged(prepared, file, file.before, io)
    for (const file of prepared.files) staged.set(file, await stage(file, file.after))
    // Recheck every snapshot after all staging, before the first replacement.
    for (const file of prepared.files) await unchanged(prepared, file, file.before, io)
    for (const file of prepared.files) {
      await unchanged(prepared, file, file.before, io)
      const temp = staged.get(file)!
      await io.rename(temp, file.file); artifacts.delete(temp); replaced.push(file)
    }
  } catch (error) {
    failure = error
    for (const file of replaced.toReversed()) {
      try {
        await unchanged(prepared, file, file.after, io)
        const temp = await stage(file, file.before)
        await unchanged(prepared, file, file.after, io)
        await io.rename(temp, file.file); artifacts.delete(temp); restored.push(file.file)
      } catch (rollbackError) { changed.push(file.file); issues.push(String(rollbackError)) }
    }
  } finally {
    for (const temp of artifacts) {
      try { await io.rm(temp, { force: true }) }
      catch (error) { issues.push(`Temporary artifact remains ${temp}: ${String(error)}`); failure ??= error }
    }
  }
  if (failure !== undefined) {
    const untouched = prepared.files.filter(file => !replaced.includes(file)).map(file => file.file)
    const states = await Promise.all(prepared.files.map(async file => {
      try {
        const bytes = await io.readFile(file.file)
        return { file: file.file, state: bytes.equals(file.before) ? 'original' : bytes.equals(file.after) ? 'applied' : 'external change' }
      } catch { return { file: file.file, state: 'unreadable/unknown' } }
    }))
    throw new Error(`Rename write failed: ${String(failure)}; changed/unrestored: ${JSON.stringify(changed)}; restored: ${JSON.stringify(restored)}; not replaced: ${JSON.stringify(untouched)}; observed states: ${JSON.stringify(states)}${issues.length ? `; ${issues.join('; ')}` : ''}`)
  }
  return { editCount: prepared.files.reduce((count, file) => count + file.editCount, 0), files: prepared.files.map(({ source, editCount }) => ({ file: source, editCount })) }
}
