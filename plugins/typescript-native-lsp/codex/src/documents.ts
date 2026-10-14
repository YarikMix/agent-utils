import { existsSync, type Stats } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { extname, relative, sep } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { z } from 'zod'
import { endPosition, pathToUri, uriToPath } from './files.ts'
import { compileWatchPattern, containedBy, createRegisteredWatcher, type RegisteredWatcher, type WatchPattern } from './watchers.ts'

interface DocumentState { version: number; content: string; physicalPath: string }
interface FileEvent { uri: string; type: number }
interface Registration { method: string; watchers: RegisteredWatcher[]; specs: WatchPattern[] }
const registrationSchema = z.object({ registrations: z.array(z.object({ id: z.string().min(1), method: z.string(), registerOptions: z.unknown().optional() })) })
const watcherSchema = z.object({ globPattern: z.union([z.string().min(1), z.object({ baseUri: z.union([z.string(), z.object({ uri: z.string(), name: z.string().optional() })]), pattern: z.string().min(1) })]), kind: z.number().int().min(1).max(7).optional() })
/** One leased document snapshot and queued filesystem notifications per project. */
export class DocumentSession {
  private documents = new Map<string, DocumentState>()
  private events = new Map<string, FileEvent>()
  private watchers = new Set<FSWatcher>()
  private registeredWatchers = new Set<RegisteredWatcher>()
  private readiness = new Set<Promise<void>>()
  private settleReady = new Map<FSWatcher, () => void>()
  private registrations = new Map<string, Registration>()
  private watcherError?: Error
  private closed = false
  private closing?: Promise<void>
  private syncKind = 1
  private revision = 0
  private knownDependencies = new Set<string>()

  constructor(private root: string, private notify: (method: string, params: unknown) => void) {
    pathToUri(root)
    const watcher = this.watch(root, file => /\.(?:[cm]?[jt]sx?|json)$/.test(file), 7, file => {
      const parts = relative(root, file).split(sep)
      return parts.includes('node_modules') || parts.includes('.git')
    })
    // This watcher starts with the session, and cleanup owns it immediately.
    void watcher
  }

  get generation(): number { return this.revision }
  getVersion(uri: string): number | undefined { return this.documents.get(uri)?.version }
  getText(uri: string): string | undefined { return this.documents.get(uri)?.content }

  /** Detached snapshots for physical-alias validation; callers cannot mutate session state. */
  getOpenedDocuments(): ReadonlyArray<Readonly<{ uri: string; content: string; physicalPath: string }>> {
    return [...this.documents].map(([uri, { content, physicalPath }]) => ({ uri, content, physicalPath }))
  }

  /** Native-returned file identities, without opening files or widening watcher scope. */
  noteDependencies(files: readonly string[]): void {
    const added = files.filter(file => !this.knownDependencies.has(file))
    for (const file of added) {
      pathToUri(file)
      this.knownDependencies.add(file)
      for (const watcher of this.registeredWatchers) watcher.noteFile(file)
    }
    // A watcher event may have arrived while native metadata was in flight, before
    // this session knew that its path mattered. Do not mint an ID across that race.
    if ([...this.events.values()].some(event => added.some(file =>
      event.type === 3 ? containedBy(file, uriToPath(event.uri)) : containedBy(file, uriToPath(event.uri)) && containedBy(uriToPath(event.uri), file),
    ))) this.revision++
  }

  setSyncKind(value: unknown): void {
    const parsed = z.union([z.number().int().min(0).max(2), z.object({ openClose: z.boolean().optional(), change: z.number().int().min(0).max(2).optional() })]).safeParse(value)
    if (!parsed.success) throw new Error('Invalid LSP textDocumentSync capability')
    this.syncKind = typeof parsed.data === 'number' ? parsed.data : parsed.data.change ?? 0
  }

  private enqueue(file: string, type: number): void {
    if (this.closed) return
    const uri = pathToUri(file)
    const key = `${uri}:${type}`
    if (!this.events.has(key)) {
      this.events.set(key, { uri, type })
      if (this.isSemanticEvent(file, type)) this.revision++
    }
  }

  /** Native notification scope may include entire ancestors; semantic scope does not. */
  private isSemanticEvent(file: string, type: number): boolean {
    const opened = [...this.documents.keys()].map(uriToPath)
    if (opened.some(path => path === file || (type === 3 && containedBy(path, file)))) return true
    const parts = relative(this.root, file).split(sep)
    const projectFile = containedBy(file, this.root) && !parts.includes('node_modules') && !parts.includes('.git')
    if (projectFile && (/\.(?:[cm]?[jt]sx?|json)$/.test(file) || type === 3)) return true
    if (type === 3 && containedBy(this.root, file)) return true
    if ([...this.knownDependencies].some(path => containedBy(path, file) && (type === 3 || containedBy(file, path)))) return true
    for (const { specs } of this.registrations.values()) {
      for (const spec of specs) {
        if (!(spec.kind & (1 << (type - 1)))) continue
        if (spec.semanticFileSignal && spec.matches(file)) {
          this.knownDependencies.add(file)
          return true
        }
        // A concrete registration also identifies possible unopened descendants.
        if (type === 3 && !spec.ancestorWide && (containedBy(spec.semanticRoot, file) || containedBy(file, spec.semanticRoot))) return true
      }
    }
    return false
  }

  private watch(root: string, matches: (file: string) => boolean, kind: number, ignored?: (file: string, stats?: Stats) => boolean, ignorePermissionErrors = false): FSWatcher {
    if (this.closed) throw new Error('Document session is closed')
    const watcher = chokidar.watch(root, { ignoreInitial: true, ignorePermissionErrors, usePolling: true, interval: 100, binaryInterval: 100, ...(ignored ? { ignored } : {}) })
    this.watchers.add(watcher)
    const ready = new Promise<void>((resolveReady, reject) => {
      this.settleReady.set(watcher, resolveReady)
      watcher.once('ready', resolveReady)
      watcher.on('error', error => {
        this.watcherError = error instanceof Error ? error : new Error(String(error))
        reject(this.watcherError)
      })
    })
    this.readiness.add(ready)
    // Errors remain observable by flush even when nobody is awaiting registration.
    void ready.catch(() => {}).finally(() => { this.readiness.delete(ready); this.settleReady.delete(watcher) })
    for (const [event, type, mask] of [['add', 1, 1], ['change', 2, 2], ['unlink', 3, 4]] as const) {
      watcher.on(event, file => { if ((kind & mask) && matches(file)) this.enqueue(file, type) })
    }
    return watcher
  }

  async register(params: unknown): Promise<void> {
    if (this.closed) throw new Error('Document session is closed')
    const { registrations } = registrationSchema.parse(params)
    const ids = new Set<string>()
    const entries = registrations.map(entry => {
      if (ids.has(entry.id) || this.registrations.has(entry.id)) throw new Error('Duplicate LSP registration')
      ids.add(entry.id)
      if (entry.method === 'workspace/didChangeConfiguration') {
        z.object({ section: z.union([z.string(), z.array(z.string())]).optional() }).parse(entry.registerOptions ?? {})
        return { ...entry, specs: [] }
      }
      if (entry.method !== 'workspace/didChangeWatchedFiles') throw new Error(`Unsupported LSP registration: ${entry.method}`)
      const options = z.object({ watchers: z.array(watcherSchema) }).parse(entry.registerOptions)
      return { ...entry, specs: options.watchers.map(raw => compileWatchPattern(this.root, raw)) }
    })
    const created: string[] = []
    try {
      for (const entry of entries) {
        const registration: Registration = { method: entry.method, watchers: [], specs: entry.specs }
        this.registrations.set(entry.id, registration); created.push(entry.id)
        for (const spec of entry.specs) {
          const watcher = createRegisteredWatcher(spec, (file, type) => this.enqueue(file, type), error => { this.watcherError = error })
          // Native may register an ancestor after documents/metadata were loaded.
          for (const file of this.knownDependencies) if (existsSync(file)) watcher.noteFile(file)
          for (const uri of this.documents.keys()) { const file = uriToPath(uri); if (existsSync(file)) watcher.noteFile(file) }
          registration.watchers.push(watcher); this.registeredWatchers.add(watcher)
          this.readiness.add(watcher.ready)
          void watcher.ready.catch(() => {}).finally(() => this.readiness.delete(watcher.ready))
        }
      }
      await this.waitForWatchers()
      if (this.closed) throw new Error('Document session closed during registration')
    } catch (error) {
      await Promise.all(created.map(id => this.removeRegistration(id)))
      throw error
    }
  }

  async unregister(params: unknown): Promise<void> {
    // The misspelling is part of the LSP wire protocol.
    const { unregisterations } = z.object({ unregisterations: z.array(z.object({ id: z.string(), method: z.string() })) }).parse(params)
    for (const entry of unregisterations) {
      const registration = this.registrations.get(entry.id)
      if (!registration || registration.method !== entry.method) throw new Error('Unknown LSP unregistration')
    }
    await Promise.all(unregisterations.map(entry => this.removeRegistration(entry.id)))
  }

  private async removeRegistration(id: string): Promise<void> {
    const registration = this.registrations.get(id)
    this.registrations.delete(id)
    await Promise.all((registration?.watchers ?? []).map(async watcher => {
      await watcher.close(); this.registeredWatchers.delete(watcher)
    }))
  }

  private async waitForWatchers(): Promise<void> {
    await Promise.all([...this.readiness])
    if (this.watcherError) throw this.watcherError
  }

  async flushFileEvents(): Promise<void> {
    if (this.closed) throw new Error('Document session is closed')
    await this.waitForWatchers()
    await Promise.all([...this.registeredWatchers].map(watcher => watcher.flush()))
    if (this.watcherError) throw this.watcherError
    if (this.events.size) {
      const changes = [...this.events.values()]
      this.events.clear()
      this.notify('workspace/didChangeWatchedFiles', { changes })
    }
  }

  private deleted(uri: string): void {
    this.notify('textDocument/didClose', { textDocument: { uri } })
    this.documents.delete(uri)
    this.revision++
    this.enqueue(uriToPath(uri), 3)
  }

  private changed(uri: string, state: DocumentState, content: string, physicalPath: string): void {
    // Retargeting is a new native snapshot even when the replacement bytes match.
    if (state.content === content && state.physicalPath === physicalPath) return
    if (!this.syncKind) throw new Error('LSP server does not support document changes')
    const version = state.version + 1
    const change = this.syncKind === 2 ? { range: { start: { line: 0, character: 0 }, end: endPosition(state.content) }, text: content } : { text: content }
    this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [change] })
    this.documents.set(uri, { version, content, physicalPath }); this.revision++
  }

  /** A project selector is validated/read without opening a new native document. */
  async sync(file: string, options: { open?: boolean } = {}): Promise<string> {
    const uri = pathToUri(file)
    await this.flushFileEvents()
    for (const [openUri, state] of this.documents) {
      let content: string; let physicalPath: string
      try {
        physicalPath = await realpath(uriToPath(openUri))
        content = await readFile(physicalPath, 'utf8')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.deleted(openUri); continue
      }
      this.changed(openUri, state, content, physicalPath)
    }
    await this.flushFileEvents()
    const physicalPath = await realpath(file)
    const content = await readFile(physicalPath, 'utf8')
    for (const watcher of this.registeredWatchers) watcher.noteFile(file)
    const state = this.documents.get(uri)
    if (state) this.changed(uri, state, content, physicalPath)
    else if (options.open !== false) {
      const extension = extname(file)
      const languageId = extension === '.tsx' ? 'typescriptreact' : extension === '.jsx' ? 'javascriptreact' : ['.js', '.mjs', '.cjs'].includes(extension) ? 'javascript' : 'typescript'
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text: content } })
      this.documents.set(uri, { version: 1, content, physicalPath }); this.revision++
    }
    return content
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const settle of this.settleReady.values()) settle()
    this.closing = Promise.all([...this.watchers, ...this.registeredWatchers].map(watcher => watcher.close())).then(() => {
      this.watchers.clear(); this.registeredWatchers.clear(); this.documents.clear(); this.events.clear(); this.knownDependencies.clear()
      // Native shutdown can unregister capabilities after local handles are closed.
      for (const registration of this.registrations.values()) registration.watchers = []
    })
    return this.closing
  }
}
