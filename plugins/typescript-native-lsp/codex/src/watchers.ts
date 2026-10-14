import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher, type Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import chokidar from 'chokidar'
import picomatch from 'picomatch'
import { uriToPath } from './files.ts'

export interface WatchPattern {
  root: string
  nativeRecursive: boolean
  matches(file: string): boolean
  ignored(file: string, stats?: Stats): boolean
  kind: number
}
export interface WatchInput { globPattern: string | { baseUri: string | { uri: string; name?: string }; pattern: string }; kind?: number }
export interface RegisteredWatcher {
  readonly ready: Promise<void>
  close(): Promise<void>
  flush(): Promise<void>
  noteFile(file: string): void
}
const slash = (file: string) => file.split(sep).join('/')
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
const permissionError = (error: unknown) => ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')

/** TS case-folds paths on macOS/Windows; retain their actual disk spelling. */
function actualCase(file: string): string {
  if (!caseInsensitive) return file
  let current = parse(file).root
  for (const component of file.slice(current.length).split(sep).filter(Boolean)) {
    let spelling = component
    try { spelling = readdirSync(current).find(name => name.toLowerCase() === component.toLowerCase()) ?? component }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !permissionError(error)) throw error }
    current = join(current, spelling)
  }
  return current
}

export function compileWatchPattern(root: string, raw: WatchInput): WatchPattern {
  const pattern = raw.globPattern
  let absolute: string
  if (typeof pattern === 'string') absolute = pattern.startsWith('file:') ? uriToPath(pattern) : isAbsolute(pattern) ? pattern : resolve(root, pattern)
  else {
    const base = uriToPath(typeof pattern.baseUri === 'string' ? pattern.baseUri : pattern.baseUri.uri)
    if (isAbsolute(pattern.pattern)) throw new Error('RelativePattern must be relative')
    absolute = resolve(base, pattern.pattern)
  }
  const normalized = slash(absolute)
  const scan = picomatch.scan(normalized)
  const staticRoot = actualCase(scan.isGlob ? scan.base : dirname(absolute))
  let watchRoot = staticRoot
  if (!watchRoot || !isAbsolute(watchRoot)) throw new Error('Invalid watcher pattern root')
  while (!existsSync(watchRoot)) { const parent = dirname(watchRoot); if (parent === watchRoot) break; watchRoot = parent }
  if (existsSync(watchRoot) && !statSync(watchRoot).isDirectory()) watchRoot = dirname(watchRoot)
  let nativeRecursive = false
  if (caseInsensitive && staticRoot === watchRoot) {
    try {
      const physicalWatchRoot = realpathSync(watchRoot)
      const physicalProjectRoot = realpathSync(actualCase(root))
      const relationship = relative(physicalWatchRoot.toLowerCase(), physicalProjectRoot.toLowerCase())
      nativeRecursive = relationship !== '' && relationship !== '..' && !relationship.startsWith('..' + sep) && !isAbsolute(relationship)
    } catch (error) { if (!permissionError(error)) throw error }
  }
  const matches = picomatch(normalized, { dot: true, nocase: caseInsensitive })
  const prefix = caseInsensitive ? slash(staticRoot).toLowerCase() : slash(staticRoot)
  return { root: watchRoot, nativeRecursive, kind: raw.kind ?? 7, matches: file => matches(slash(file)), ignored(file, stats) {
    if (stats && !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink()) return true
    const candidate = caseInsensitive ? slash(file).toLowerCase() : slash(file)
    return candidate !== prefix && !candidate.startsWith(prefix + '/') && !prefix.startsWith(candidate + '/')
  } }
}

/** Register a live recursive backend without crawling a broad root on macOS/Windows. */
export function createRegisteredWatcher(pattern: WatchPattern, emit: (file: string, type: number) => void, fail: (error: Error) => void): RegisteredWatcher {
  const output = (file: string, type: number) => { if ((pattern.kind & (1 << (type - 1))) && pattern.matches(file)) emit(file, type) }
  if (!pattern.nativeRecursive) {
    const watcher = chokidar.watch(pattern.root, { ignoreInitial: true, ignorePermissionErrors: true, ignored: pattern.ignored, usePolling: true, interval: 100, binaryInterval: 100 })
    let settle!: () => void
    const ready = new Promise<void>((resolveReady, reject) => {
      settle = resolveReady; watcher.once('ready', resolveReady)
      watcher.on('error', error => { const normalized = error instanceof Error ? error : new Error(String(error)); fail(normalized); reject(normalized) })
    })
    void ready.catch(() => {})
    for (const [event, type] of [['add', 1], ['change', 2], ['unlink', 3]] as const) watcher.on(event, file => output(file, type))
    return { ready, flush: () => ready, noteFile() {}, async close() { settle(); await watcher.close() } }
  }
  const known = new Set<string>()
  let closed = false
  let work: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined
  const inspect = async (file: string, event: string): Promise<void> => {
    if (closed || pattern.ignored(file)) return
    let stats: Stats
    try { stats = await lstat(file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const descendants = [...known].filter(knownFile => knownFile === file || knownFile.startsWith(file + sep))
        if (!descendants.length) output(file, 3)
        for (const descendant of descendants) { known.delete(descendant); output(descendant, 3) }
        return
      }
      if (permissionError(error)) return
      throw error
    }
    if (pattern.ignored(file, stats)) return
    if (stats.isDirectory()) {
      // Traverse only a directory named by a live event, never the whole watch root.
      let entries
      try { entries = await readdir(file, { withFileTypes: true }) }
      catch (error) { if (permissionError(error) || (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries) { if (closed) break; await inspect(join(file, entry.name), event) }
      return
    }
    if (!stats.isFile()) return
    if (known.has(file)) output(file, 2)
    else {
      // fs.watch's first event cannot establish whether the file previously existed.
      // Conservatively invalidate both categories, filtered by their watch-kind masks.
      output(file, 1); output(file, 2)
    }
    known.add(file)
  }
  let watcher: FSWatcher
  watcher = watch(pattern.root, { recursive: true }, (event, filename) => {
    if (closed) return
    if (filename === null) { fail(new Error('Native file watcher did not identify the changed path')); return }
    const file = join(pattern.root, String(filename))
    work = work.then(() => inspect(file, event)).catch(error => { if (!closed && !permissionError(error)) fail(error instanceof Error ? error : new Error(String(error))) })
  })
  watcher.on('error', error => { if (!closed && !permissionError(error)) fail(error) })
  return { ready: new Promise<void>(resolveReady => setImmediate(resolveReady)), flush: () => work, noteFile(file) { known.add(file) }, close() {
    if (closing) return closing
    closed = true; watcher.close()
    closing = work.then(() => { known.clear() })
    return closing
  } }
}
