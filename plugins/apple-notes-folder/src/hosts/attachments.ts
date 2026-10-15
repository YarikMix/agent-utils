import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { ToolError } from '../errors.js';
import { MAX_IMAGE_BYTES, sniffImageMime } from '../images.js';
import type { AttachmentContext, Host, VerifiedAttachment } from './types.js';

type SessionContext = Omit<AttachmentContext, 'callId'>;

export function provenanceError(reason: string): ToolError {
  return new ToolError('IMAGE_PROVENANCE', `Не удалось подтвердить исходное пользовательское вложение: ${reason}.`);
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

/** Only the reviewed hook envelope is normalized; the transcript supplies session binding. */
export function parseHookContext(host: Host, raw: unknown, tool: true): AttachmentContext | null;
export function parseHookContext(host: Host, raw: unknown, tool: false): SessionContext | null;
export function parseHookContext(host: Host, raw: unknown, tool: boolean): AttachmentContext | SessionContext | null {
  const value = object(raw);
  if (!value || !nonempty(value.session_id) || !nonempty(value.transcript_path) || !isAbsolute(value.transcript_path)) return null;
  const context: SessionContext = { host, sessionId: value.session_id, transcriptPath: value.transcript_path };
  if (!tool) return value.hook_event_name === 'UserPromptSubmit' ? context : null;
  if ((value.hook_event_name !== 'PreToolUse' && value.hook_event_name !== 'PostToolUse') || !nonempty(value.tool_use_id)) return null;
  return { ...context, callId: value.tool_use_id };
}

/** Read this hook's exact transcript only. No session discovery or image-path reads. */
export async function* transcriptRecords(context: SessionContext): AsyncGenerator<Record<string, unknown>> {
  if (!nonempty(context.sessionId) || !nonempty(context.transcriptPath) || !isAbsolute(context.transcriptPath)) {
    throw provenanceError('неполный контекст сессии');
  }
  let file;
  try {
    file = await open(context.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await file.stat()).isFile()) throw provenanceError('transcript не является обычным файлом');
    const stream = file.createReadStream({ encoding: 'utf8', autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record: Record<string, unknown> | null;
        try { record = object(JSON.parse(line)); }
        catch { throw provenanceError('transcript содержит повреждённый или оборванный JSONL'); }
        if (!record) throw provenanceError('неизвестный формат записи transcript');
        yield record;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw provenanceError('transcript текущей сессии недоступен');
  } finally {
    await file?.close();
  }
}

/** Decode preserved host bytes, checking encoded size before allocating the image buffer. */
export function inlineAttachment(data: unknown, mediaType: unknown): VerifiedAttachment {
  if (typeof data !== 'string' || typeof mediaType !== 'string') throw provenanceError('нет сохранённых inline bytes');
  if (data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw provenanceError('изображение больше 10 МБ');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (data.length / 4 * 3 - padding > MAX_IMAGE_BYTES) throw provenanceError('изображение больше 10 МБ');
  const alphabet = data.slice(0, data.length - padding);
  if (!data.length || data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(alphabet)) {
    throw provenanceError('невалидный base64 изображения');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw provenanceError('изображение больше 10 МБ');
  if (bytes.toString('base64') !== data) throw provenanceError('невалидный base64 изображения');
  const mime = sniffImageMime(bytes.subarray(0, 16));
  if (!mime || mime !== mediaType) throw provenanceError('неподдерживаемая сигнатура или несовпадение формата изображения');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Observed host image records have no trustworthy per-image path metadata.
  return { href: `attachment:${sha256}`, aliases: [], bytes, sha256 };
}

export async function readVerifiedAttachments(context: SessionContext): Promise<VerifiedAttachment[]> {
  if (context.host === 'claude') return (await import('./claude.js')).readAttachments(context);
  if (context.host === 'codex') return (await import('./codex.js')).readAttachments(context);
  throw provenanceError('неизвестный клиент');
}
