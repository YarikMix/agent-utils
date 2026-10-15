import { ToolError } from './errors.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

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
