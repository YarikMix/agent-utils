import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from './runner.js';
import { SCRIPTS } from './scripts.js';

export interface NoteSummary {
  id: string;
  name: string;
  modified: string;
}

export interface NoteFull extends NoteSummary {
  body: string;
  attachments: number;
}

/** HTML тела уходит в скрипт временным файлом, а не аргументом: так он не упирается в лимит argv. */
export async function withHtmlFile<T>(html: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'apple-notes-folder-'));
  const path = join(dir, 'body.html');
  try {
    await writeFile(path, html, { mode: 0o600 });
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class NotesService {
  constructor(
    private readonly run: Runner,
    private readonly folderId: string,
    private readonly snapshotPaths: readonly string[] = [],
  ) {}

  private async call<T>(script: string, args: string[], write: boolean): Promise<T> {
    return JSON.parse(await this.run(script, [this.folderId, ...args], { write })) as T;
  }

  list(): Promise<NoteSummary[]> {
    return this.call(SCRIPTS.listNotes, [], false);
  }

  search(query: string): Promise<NoteSummary[]> {
    return this.call(SCRIPTS.searchNotes, [query], false);
  }

  read(id: string): Promise<NoteFull> {
    return this.call(SCRIPTS.readNote, [id], false);
  }

  async create(html: string): Promise<string> {
    const r = await withHtmlFile(html, (p) => this.call<{ id: string }>(SCRIPTS.createNote, [p, JSON.stringify(this.snapshotPaths)], true));
    return r.id;
  }

  async append(id: string, html: string): Promise<void> {
    await withHtmlFile(html, (p) => this.call(SCRIPTS.appendNote, [id, p, JSON.stringify(this.snapshotPaths)], true));
  }

  async update(id: string, html: string): Promise<void> {
    await withHtmlFile(html, (p) => this.call(SCRIPTS.updateNote, [id, p, JSON.stringify(this.snapshotPaths)], true));
  }

  async delete(id: string): Promise<void> {
    await this.call(SCRIPTS.deleteNote, [id], true);
  }
}
