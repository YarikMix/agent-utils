import { inlineAttachment, nonempty, object, parseHookContext, provenanceError, transcriptRecords } from './attachments.js';
import type { AttachmentContext, VerifiedAttachment } from './types.js';

export function parseToolContext(raw: unknown): AttachmentContext | null {
  return parseHookContext('codex', raw, true);
}

export function parseSessionContext(raw: unknown): Omit<AttachmentContext, 'callId'> | null {
  return parseHookContext('codex', raw, false);
}

/** Codex 0.162.1 retained user records, including previous messages of this session. */
export async function readAttachments(context: Omit<AttachmentContext, 'callId'>): Promise<VerifiedAttachment[]> {
  if (context.host !== 'codex') throw provenanceError('контекст другого клиента');
  const attachments = new Map<string, VerifiedAttachment>();
  let bound = false;
  for await (const record of transcriptRecords(context)) {
    const payload = object(record.payload);
    if (record.type === 'session_meta') {
      if (bound || payload?.id !== context.sessionId) throw provenanceError('transcript принадлежит другой или неоднозначной сессии');
      bound = true;
      continue;
    }
    if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') continue;
    if (!bound) throw provenanceError('нет привязки пользовательского сообщения к сессии');
    if (!Array.isArray(payload.content)) throw provenanceError('неизвестный формат пользовательского сообщения');
    const metadata = object(payload.internal_chat_message_metadata_passthrough);
    const kinds = metadata?.content_item_kinds;
    if (Array.isArray(kinds) && (kinds.includes('images.preparation_error')
      || (kinds.includes('user.image') && !payload.content.some(raw => object(raw)?.type === 'input_image')))) {
      throw provenanceError('исходные bytes пользовательского изображения недоступны после подготовки');
    }
    for (const raw of payload.content) {
      const item = object(raw);
      if (!item) throw provenanceError('неизвестный блок пользовательского сообщения');
      if (item.type === 'input_text') continue;
      if (item.type !== 'input_image') throw provenanceError('неподдерживаемый источник вложения Codex');
      const source = object(object(object(record.metadata)?.retained_source)?.id);
      if (!nonempty(payload.id) || !nonempty(metadata?.turn_id) || source?.message_id !== payload.id || source?.turn_id !== metadata.turn_id || source?.role !== 'user'
        || !Array.isArray(metadata.content_item_kinds) || !metadata.content_item_kinds.includes('user.image')) {
        throw provenanceError('не совпадает идентичность сохранённого пользовательского изображения');
      }
      if (typeof item.image_url !== 'string') throw provenanceError('нет сохранённых исходных inline bytes Codex');
      const match = /^data:(image\/[a-z]+);base64,([\s\S]*)$/.exec(item.image_url);
      if (!match) throw provenanceError('неподдерживаемый источник inline bytes Codex');
      const attachment = inlineAttachment(match[2], match[1]);
      attachments.set(attachment.href, attachment);
    }
  }
  if (!bound) throw provenanceError('неизвестный формат transcript Codex или отсутствует сессия');
  return [...attachments.values()];
}
