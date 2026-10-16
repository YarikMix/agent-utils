import { attachmentHook } from './attachment-hook.js';
import { object } from './hosts/attachments.js';
import type { Clock, Host, RuntimePaths } from './hosts/types.js';

const SCRIPTING = /osascript|applescript|jxa|scriptingbridge/i;
// Упоминание "Notes" как имя приложения в кавычках (одинарных/двойных/обратных, кавычка может быть
// экранирована обратным слэшем перед закрывающей), с необязательным путём перед именем и необязательным
// ".app" после него (`"Notes"`, `"Notes.app"`, `"/System/Applications/Notes.app"`) — либо bundle id, либо
// файл базы; не голое слово "notes".
const NOTES = /(["'`])(?:[^"'`]*\/)?notes(?:\.app)?\\?\1|com\.apple\.notes|notestore/i;
const SQLITE = /sqlite/i;
const NOTESTORE = /notestore/i;

export const DENY_REASON =
  'Прямой доступ к Apple Notes из Bash запрещён плагином apple-notes-folder. Работайте с заметками через инструменты notes_* — они ограничены разрешённой папкой.';

/** Очевидный обход сервера: скриптовый доступ к Заметкам или чтение их базы. Намеренный обход не ловится. */
export function shouldDeny(command: string): boolean {
  return (SCRIPTING.test(command) && NOTES.test(command)) || (SQLITE.test(command) && NOTESTORE.test(command));
}

/**
 * Чистая логика хука: JSON отказа для запрещённого вызова Bash/Monitor, иначе пустая строка. Без сайд-эффектов.
 * Monitor (инструмент наблюдения за фоновым процессом Claude Code) тоже несёт shell-команду в tool_input.command.
 */
export function hookOutput(input: string): string {
  let command = '';
  try {
    const call = JSON.parse(input);
    if (call?.tool_name === 'Bash' || call?.tool_name === 'Monitor') command = String(call?.tool_input?.command ?? '');
  } catch {
    return '';
  }
  if (!shouldDeny(command)) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
  });
}

/** Shell protection runs before any attachment parsing or transcript I/O. */
export async function runHook(host: Host, input: string, paths: RuntimePaths, now: Clock = Date.now): Promise<string> {
  let raw: unknown;
  try { raw = JSON.parse(input); } catch { return ''; }
  const call = object(raw);
  if (!call) return '';
  if ((call.hook_event_name === undefined || call.hook_event_name === 'PreToolUse') &&
      (call.tool_name === 'Bash' || (host === 'claude' && call.tool_name === 'Monitor'))) {
    const shellOutput = hookOutput(input);
    if (shellOutput) return shellOutput;
  }
  return attachmentHook(host, raw, paths, now);
}
