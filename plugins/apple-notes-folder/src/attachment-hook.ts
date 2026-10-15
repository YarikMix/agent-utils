import { issueTicket } from './attachments/tickets.js';
import { object, readVerifiedAttachments } from './hosts/attachments.js';
import * as claude from './hosts/claude.js';
import * as codex from './hosts/codex.js';
import type { Clock, Host, RuntimePaths, VerifiedAttachment, WriteArgs, WriteToolName } from './hosts/types.js';
import { imageHrefs } from './markdown.js';

// Codex namespace observed in Task 1. Claude production plugin prefix is derived
// from our auth-free probe's system/init.tools; packaging must validate it.
const prefixes: Record<Host, string> = {
  codex: 'mcp__apple_notes_folder__',
  claude: 'mcp__plugin_apple-notes-folder_apple-notes-folder__',
};
const writeNames: WriteToolName[] = ['notes_create', 'notes_append', 'notes_update'];
const safeHrefs = (attachments: VerifiedAttachment[]) => attachments.map(a => a.href).filter(href => /^attachment:[a-f0-9]{64}$/.test(href));
const available = (attachments: VerifiedAttachment[]) => {
  const hrefs = safeHrefs(attachments);
  return hrefs.length ? ` Доступные ссылки пользовательских вложений: ${hrefs.join(', ')}.` : '';
};
const deny = (attachments: VerifiedAttachment[] = []) => JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `Не удалось подтвердить картинку пользовательским вложением текущего диалога. Повторите вызов с подтверждённой ссылкой.${available(attachments)}`,
  },
});

/** Grants originate only from preserved user bytes in this hook's session. */
export async function attachmentHook(host: Host, input: unknown, paths: RuntimePaths, now: Clock = Date.now): Promise<string> {
  const raw = object(input);
  if (!raw) return '';
  const adapter = host === 'claude' ? claude : codex;
  if (raw.hook_event_name === 'UserPromptSubmit') {
    const context = adapter.parseSessionContext(raw);
    if (!context) return '';
    try {
      const attachments = await readVerifiedAttachments(context);
      const hint = available(attachments);
      return hint ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hint.trim() } }) : '';
    } catch { return ''; } // Preparation may not yet have preserved bytes; PreToolUse retries verification.
  }
  if (raw.hook_event_name !== 'PreToolUse') return '';
  const name = writeNames.find(name => raw.tool_name === `${prefixes[host]}${name}`);
  const args = object(raw.tool_input);
  if (!name || !args || typeof args.markdown !== 'string') return '';
  let attachments: VerifiedAttachment[] = [];
  try {
    // The converter and hook share the same lexer, including nested/reference images.
    // Text-only writes never open the transcript or touch the runtime.
    if (!imageHrefs(args.markdown).length) return '';
    const context = adapter.parseToolContext(raw);
    if (!context) return deny();
    attachments = await readVerifiedAttachments(context);
    const ticket = await issueTicket(paths, context, name, args as WriteArgs, attachments, now);
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...args, attachment_ticket: ticket },
    } });
  } catch { return deny(attachments); }
}
