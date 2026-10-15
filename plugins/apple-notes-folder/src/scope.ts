import { CONFIGURE_HINT, ToolError } from './errors.js';
import type { Runner } from './runner.js';
import { SCRIPTS } from './scripts.js';

export interface Scope {
  folderId: string;
  folderName: string;
}

interface FolderInfo {
  id: string;
  name: string;
  account: string;
}

export function configuredFolder(env: NodeJS.ProcessEnv): string | null {
  const v = env.NOTES_FOLDER?.trim();
  if (!v || v.startsWith('${')) return null;
  return v;
}

const RECENTLY_DELETED_NAMES = new Set(['recently deleted', 'недавно удалённые', 'недавно удаленные']);

export async function resolveScope(name: string | null, run: Runner, hint: string = CONFIGURE_HINT): Promise<Scope> {
  if (!name) throw new ToolError('CONFIG', `Не задана папка Заметок. Укажите её: ${hint}.`);
  if (RECENTLY_DELETED_NAMES.has(name.trim().toLowerCase())) {
    throw new ToolError('CONFIG', `Папку «${name}» нельзя выбрать: в ней лежат удалённые заметки из всех папок.`);
  }

  const byId = new Map<string, FolderInfo>();
  for (const f of JSON.parse(await run(SCRIPTS.listFolders, [], { write: false })) as FolderInfo[]) byId.set(f.id, f);
  const matches = [...byId.values()].filter((f) => f.name === name);

  if (matches.length === 0) {
    throw new ToolError(
      'CONFIG',
      `Папка «${name}» не найдена в Заметках. Проверьте имя: ${hint}. Папка по умолчанию в скриптах может называться иначе, чем в интерфейсе: в русском интерфейсе «Заметки», в скриптах «Notes».`,
    );
  }
  if (matches.length > 1) {
    const accounts = [...new Set(matches.map((m) => m.account))].join(', ');
    throw new ToolError(
      'CONFIG',
      `Папок с именем «${name}» несколько (${matches.length}; аккаунты: ${accounts}). Переименуйте лишние или укажите другую папку: ${hint}.`,
    );
  }
  return { folderId: matches[0].id, folderName: name };
}

export function makeScopeProvider(name: string | null, run: Runner, hint: string = CONFIGURE_HINT): () => Promise<Scope> {
  let pending: Promise<Scope> | null = null;
  return () => {
    if (!pending) {
      const attempt = resolveScope(name, run, hint);
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) pending = null;
      });
    }
    return pending;
  };
}
