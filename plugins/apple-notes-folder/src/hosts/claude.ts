import { inlineAttachment, nonempty, object, parseHookContext, provenanceError, transcriptRecords } from './attachments.js';
import type { AttachmentContext, VerifiedAttachment } from './types.js';

export function parseToolContext(raw: unknown): AttachmentContext | null {
  return parseHookContext('claude', raw, true);
}

export function parseSessionContext(raw: unknown): Omit<AttachmentContext, 'callId'> | null {
  return parseHookContext('claude', raw, false);
}

/** Observed persisted user-image structure; full Claude model/tool flow remains unverified. */
export async function readAttachments(context: Omit<AttachmentContext, 'callId'>): Promise<VerifiedAttachment[]> {
  if (context.host !== 'claude') throw provenanceError('контекст другого клиента');
  const attachments = new Map<string, VerifiedAttachment>();
  let bound = false;
  for await (const record of transcriptRecords(context)) {
    if ('sessionId' in record) {
      if (record.sessionId !== context.sessionId) throw provenanceError('transcript принадлежит другой сессии');
      bound = true;
    }
    if (record.type !== 'user') continue;
    if (record.sessionId !== context.sessionId) throw provenanceError('у пользовательской записи нет привязки к сессии');
    // Tool/synthetic companions and sidechain messages are not user-upload grants.
    if (record.isMeta === true || record.turnCompanion === true || record.isSidechain === true) continue;
    const message = object(record.message);
    if (message?.role !== 'user') throw provenanceError('неподтверждённая роль пользовательской записи');
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content)) throw provenanceError('неизвестный формат пользовательского сообщения');
    for (const raw of message.content) {
      const item = object(raw);
      if (!item) throw provenanceError('неизвестный блок пользовательского сообщения');
      if (item.type === 'text' || item.type === 'tool_result') continue;
      if (item.type !== 'image') throw provenanceError('неподдерживаемый источник вложения Claude');
      if (!nonempty(record.uuid) || record.isSidechain !== false) throw provenanceError('нет идентичности исходного пользовательского сообщения');
      const source = object(item.source);
      if (source?.type !== 'base64') throw provenanceError('нет сохранённых исходных inline bytes Claude');
      const attachment = inlineAttachment(source.data, source.media_type);
      attachments.set(attachment.href, attachment);
    }
  }
  if (!bound) throw provenanceError('неизвестный формат transcript Claude или отсутствует сессия');
  return [...attachments.values()];
}
