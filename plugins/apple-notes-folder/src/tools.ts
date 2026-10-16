import { z } from 'zod';
import { MESSAGES, ToolError, reportAttachmentCleanupFailure } from './errors.js';
import { MAX_MARKDOWN_CHARS, TRUNCATION_MARKER_PREFIX, htmlToMarkdown, imageHrefs, markdownToHtml, titleHtml } from './markdown.js';
import { NotesService, type NoteSummary } from './notes.js';
import type { Runner } from './runner.js';
import type { Scope } from './scope.js';
import type { PreparedImages, WriteArgs, WriteToolName } from './hosts/types.js';

export interface ToolDeps {
  getScope: () => Promise<Scope>;
  run: Runner;
  prepareImages: (name: WriteToolName, args: WriteArgs) => Promise<PreparedImages>;
}

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: any) => Promise<string>;
}

const SCOPE_NOTE = 'Работает только с одной разрешённой папкой Apple Notes; другие папки недоступны.';
const IMAGES_HELP =
  'Картинка: ![подпись](attachment:...) — только подтверждённые пользовательские вложения текущего диалога; PNG, JPEG, GIF, HEIC или WebP до 10 МБ. Хук добавляет одноразовый attachment_ticket; в заметке картинка становится вложением. Произвольные пути к файлам не принимаются.';
const ATTACHMENTS_RULE =
  'У заметки с вложениями (картинками, файлами) — отказ: Заметки портят вложения при любом изменении текста. Такую заметку можно только читать и удалять; новый текст и картинки — в новую заметку.';
const LISTS_RULE =
  'У заметки со списками — отказ: чек-листы в HTML заметок неотличимы от обычных списков, и запись текста стёрла бы их отметки. Такую заметку можно только читать и удалять; новый текст — в новую заметку.';
const FORMATTING_NOTE =
  'Текст сохраняется; оформление, которого нет в Markdown (чек-листы, подчёркивание, цвета), может стать обычным текстом.';

export function attachmentsLine(n: number): string {
  return `\n\n[Вложений в заметке: ${n} — их содержимое сервер не показывает]`;
}

const byModifiedDesc = (a: NoteSummary, b: NoteSummary) => b.modified.localeCompare(a.modified);
const json = (v: unknown) => JSON.stringify(v, null, 2);

export function makeTools(deps: ToolDeps): ToolDef[] {
  const service = async (snapshotPaths: readonly string[] = []) => new NotesService(deps.run, (await deps.getScope()).folderId, snapshotPaths);
  const noteId = z.string().min(1).describe('id заметки из notes_list или notes_search');
  const attachmentTicket = z.string().regex(/^[a-f0-9]{64}$/).optional();
  const write = async (name: WriteToolName, args: WriteArgs, operation: (html: string, snapshotPaths: string[]) => Promise<string>) => {
    if (name === 'notes_update' && args.markdown.includes(TRUNCATION_MARKER_PREFIX)) {
      throw new ToolError('TRUNCATED', MESSAGES.TRUNCATED);
    }
    for (const href of imageHrefs(args.markdown)) {
      if (/^note-image:\d+$/.test(href)) throw new ToolError('IMAGE_REF', `Ссылка ${href} не соответствует ни одной картинке заметки.`);
    }
    const images = await deps.prepareImages(name, args);
    try {
      const html = await markdownToHtml(args.markdown, images.resolve);
      return await operation(html, images.snapshotPaths);
    } finally {
      // Cleanup must never turn a confirmed write into a retry or hide TIMEOUT_WRITE.
      try { await images.release(); } catch { reportAttachmentCleanupFailure(); }
    }
  };

  return [
    {
      name: 'notes_list',
      description: `Заметки папки: id, заголовок, дата изменения; новые сверху. ${SCOPE_NOTE}`,
      shape: {
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
      handler: async ({ limit, offset }: { limit: number; offset: number }) => {
        const all = (await (await service()).list()).sort(byModifiedDesc);
        return json({ total: all.length, offset, notes: all.slice(offset, offset + limit) });
      },
    },
    {
      name: 'notes_search',
      description: `Поиск по заголовку и тексту заметок папки. ${SCOPE_NOTE}`,
      shape: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
      handler: async ({ query, limit }: { query: string; limit: number }) => {
        const hits = (await (await service()).search(query)).sort(byModifiedDesc);
        return json({ total: hits.length, notes: hits.slice(0, limit) });
      },
    },
    {
      name: 'notes_read',
      description: `Заметка целиком в Markdown; первая строка — заголовок. Картинки заметки показаны заглушками ![картинка N](note-image:N). Если у заметки есть вложения, последняя строка ответа — «[Вложений в заметке: N — их содержимое сервер не показывает]». ${SCOPE_NOTE}`,
      shape: { id: noteId },
      annotations: { readOnlyHint: true },
      handler: async ({ id }: { id: string }) => {
        const note = await (await service()).read(id);
        const tail = note.attachments > 0 ? attachmentsLine(note.attachments) : '';
        return htmlToMarkdown(note.body, MAX_MARKDOWN_CHARS - tail.length).markdown + tail;
      },
    },
    {
      name: 'notes_create',
      description: `Новая заметка в папке. title — заголовок, markdown — текст. ${IMAGES_HELP} ${SCOPE_NOTE}`,
      shape: { title: z.string().min(1), markdown: z.string(), attachment_ticket: attachmentTicket },
      annotations: {},
      handler: async (args: WriteArgs & { title: string }) =>
        write('notes_create', args, async (html, snapshots) => json({ id: await (await service(snapshots)).create(titleHtml(args.title) + html) })),
    },
    {
      name: 'notes_append',
      description: `Дописать Markdown в конец заметки. ${FORMATTING_NOTE} ${ATTACHMENTS_RULE} ${LISTS_RULE} ${IMAGES_HELP} ${SCOPE_NOTE}`,
      shape: { id: noteId, markdown: z.string().min(1), attachment_ticket: attachmentTicket },
      annotations: {},
      handler: async (args: WriteArgs & { id: string }) =>
        write('notes_append', args, async (html, snapshots) => {
          await (await service(snapshots)).append(args.id, html);
          return json({ id: args.id });
        }),
    },
    {
      name: 'notes_update',
      description: `Заменить текст заметки целиком — в формате notes_read, с заголовком первой строкой. ${FORMATTING_NOTE} ${ATTACHMENTS_RULE} ${LISTS_RULE} Заглушки ![…](note-image:N) во входе не принимаются. ${IMAGES_HELP} ${SCOPE_NOTE}`,
      shape: { id: noteId, markdown: z.string().min(1), attachment_ticket: attachmentTicket },
      annotations: { destructiveHint: true },
      handler: async (args: WriteArgs & { id: string }) =>
        write('notes_update', args, async (html, snapshots) => {
          await (await service(snapshots)).update(args.id, html);
          return json({ id: args.id });
        }),
    },
    {
      name: 'notes_delete',
      description: `Удалить заметку; она уходит в «Недавно удалённые». ${SCOPE_NOTE}`,
      shape: { id: noteId },
      annotations: { destructiveHint: true },
      handler: async ({ id }: { id: string }) => {
        await (await service()).delete(id);
        return json({ id, deleted: true });
      },
    },
  ];
}
