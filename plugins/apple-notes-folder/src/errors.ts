export type ErrorCode =
  | 'CONFIG'
  | 'OUTSIDE'
  | 'NOT_FOUND'
  | 'LOCKED'
  | 'PERMISSION'
  | 'TIMEOUT'
  | 'TIMEOUT_WRITE'
  | 'IMAGE'
  | 'IMAGE_REF'
  | 'IMAGE_PROVENANCE'
  | 'IMAGE_TICKET'
  | 'ATTACHMENTS'
  | 'LISTS'
  | 'TRUNCATED'
  | 'OSA';

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export const CONFIGURE_HINT = '/plugin configure apple-notes-folder@yarikmix-plugins';
export const CODEX_CONFIGURE_HINT = '$apple-notes-folder:setup';

export const MESSAGES = {
  OUTSIDE: 'Заметка вне разрешённой папки.',
  NOT_FOUND: 'Заметка не найдена: неверный id или заметка удалена.',
  LOCKED: 'Заметка защищена паролем — сервер её не читает и не меняет.',
  PERMISSION:
    'Нет разрешения на управление Заметками. Выдайте его: Системные настройки → Конфиденциальность и безопасность → Автоматизация → ваш терминал → Заметки.',
  TIMEOUT: 'Заметки не ответили за 30 секунд.',
  TIMEOUT_WRITE:
    'Заметки не ответили за 30 секунд. Изменение могло примениться — перечитайте заметку перед повтором.',
  FOLDER_GONE: `Разрешённая папка больше не найдена в Заметках. Проверьте её имя (${CONFIGURE_HINT}) и перезапустите сессию.`,
  IO: 'Не удалось прочитать временный файл с текстом заметки.',
  TRUNCATED:
    'Заметка была обрезана при чтении, её полный текст агенту недоступен. Замена целиком удалила бы хвост — для такой заметки используйте notes_append.',
  LISTS:
    'В заметке есть списки. Заметки не сообщают скриптам, какие из них — чек-листы, а при изменении текста чек-листы и их отметки превращаются в обычный текст. Поэтому сервер текст этой заметки не меняет; новый текст можно записать в новую заметку.',
} as const;

/** Отказ дописывать и менять текст заметки с вложениями: запись body портит вложения. */
export function attachmentsMessage(n: number): string {
  return `У заметки есть вложения (${n}). Заметки портят вложения при любом изменении текста, поэтому сервер текст этой заметки не меняет. Картинки и новый текст можно записать в новую заметку.`;
}

export function toToolResult(e: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
  const text =
    e instanceof ToolError ? e.message : `Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}
