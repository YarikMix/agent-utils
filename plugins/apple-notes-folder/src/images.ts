import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolError } from './errors.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/** Каталог, куда Claude Code кладёт вставленные в промпт картинки и scratchpad сессий. */
export function defaultImageRoot(): string {
  return `/private/tmp/claude-${process.getuid!()}`;
}

export function sniffImageMime(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  const ascii = head.subarray(0, 16).toString('latin1');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.slice(4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii.slice(8, 12))) return 'image/heic';
  return null;
}

export function validateImageBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ToolError('IMAGE', 'Картинка больше 10 МБ.');
  if (!sniffImageMime(Buffer.from(bytes.subarray(0, 16)))) {
    throw new ToolError('IMAGE', 'Формат картинки не PNG, JPEG, GIF, HEIC или WebP.');
  }
}

/**
 * Проверяет файл картинки и возвращает file://-URL его realpath для <img src> в HTML заметки:
 * так Заметки копируют файл в заметку и показывают картинку (data:-URI они показывают битой плашкой «Файл»).
 */
export async function imageSrc(path: string, root: string = defaultImageRoot()): Promise<string> {
  const fail = (why: string) => new ToolError('IMAGE', `Картинка ${path} не принята: ${why}.`);
  if (!isAbsolute(path)) throw fail('нужен абсолютный путь');

  const st = await lstat(path).catch(() => null);
  if (!st) throw fail('файл не найден');
  if (st.isSymbolicLink()) throw fail('это символическая ссылка');
  if (!st.isFile()) throw fail('это не обычный файл');

  const realRoot = await realpath(root).catch(() => null);
  const real = await realpath(path).catch(() => null);
  if (!real) throw fail('файл не найден');
  if (!realRoot || !real.startsWith(realRoot + sep)) throw fail(`файл должен лежать в ${root}`);

  if (st.size > MAX_IMAGE_BYTES) throw fail('файл больше 10 МБ');

  const fh = await open(real, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (!sniffImageMime(head)) throw fail('формат не PNG, JPEG, GIF, HEIC или WebP');
  return pathToFileURL(real).href;
}
