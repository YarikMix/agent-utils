import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Position, Range } from './protocol.ts'

export function pathToUri(file: string): string {
  if (!isAbsolute(file)) throw new Error('File path must be absolute')
  return pathToFileURL(file).href
}

export function uriToPath(uri: string): string {
  const parsed = new URL(uri)
  if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) throw new Error('Expected a file URI without query or fragment')
  return fileURLToPath(parsed)
}

function lineBounds(text: string): { starts: number[]; ends: number[] } {
  const starts = [0]
  const ends: number[] = []
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    ends.push(match.index); starts.push(match.index + match[0].length)
  }
  ends.push(text.length)
  return { starts, ends }
}

/** JavaScript string offsets are UTF-16, matching negotiated LSP positions. */
export function positionToOffset(text: string, position: Position): number {
  const { line, character } = position
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0) throw new Error('Invalid position')
  const { starts, ends } = lineBounds(text)
  const start = starts[line]
  const end = ends[line]
  if (start === undefined || end === undefined) throw new Error('Position line is outside file')
  if (character > end - start) throw new Error('Position character is outside line')
  return start + character
}

export function endPosition(text: string): Position {
  const { starts } = lineBounds(text)
  return { line: starts.length - 1, character: text.length - starts[starts.length - 1]! }
}

/** An exclusive line boundary beyond the last actual line maps to real EOF. */
export function inlayRange(text: string, startLine: number, endLine: number): Range {
  const lines = lineBounds(text).starts.length
  if (!Number.isSafeInteger(endLine) || endLine < startLine || endLine > lines) throw new Error('Invalid inlay end position')
  const start = { line: startLine, character: 0 }
  positionToOffset(text, start)
  const end = endLine === lines ? endPosition(text) : { line: endLine, character: 0 }
  positionToOffset(text, end)
  return { start, end }
}

export async function assertProjectWritePath(root: string, file: string): Promise<string> {
  pathToUri(root); pathToUri(file)
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(file)])
  const canonical = relative(canonicalRoot, canonicalFile)
  if (canonical === '..' || canonical.startsWith(`..${sep}`) || isAbsolute(canonical)) throw new Error('Write path is outside project boundary')
  // Protect directories even when the chosen project root is itself inside one.
  for (const candidate of [root, file, canonicalRoot, canonicalFile]) {
    const parts = candidate.split(sep).map(part => ['darwin', 'win32'].includes(process.platform) ? part.toLowerCase() : part)
    if (parts.some(part => part === 'node_modules' || part === '.git')) throw new Error('Cannot write node_modules or .git')
  }
  return canonicalFile
}
