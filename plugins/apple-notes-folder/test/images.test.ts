import { describe, it, expect } from 'vitest';
import { sniffImageMime, MAX_IMAGE_BYTES, validateImageBytes } from '../src/images.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'latin1')]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(8)]);

describe('sniffImageMime', () => {
  it('узнаёт форматы по первым байтам', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(HEIC)).toBe('image/heic');
    expect(sniffImageMime(Buffer.from('просто текст'))).toBeNull();
  });
});

describe('validateImageBytes', () => {
  it('accepts all five supported signatures', () => {
    for (const bytes of [PNG, JPEG, GIF, WEBP, HEIC]) expect(() => validateImageBytes(bytes)).not.toThrow();
  });
  it('accepts exactly 10 MiB and refuses oversized or unknown bytes', () => {
    const limit = Buffer.alloc(MAX_IMAGE_BYTES);
    PNG.copy(limit);
    expect(() => validateImageBytes(limit)).not.toThrow();
    for (const bytes of [Buffer.alloc(MAX_IMAGE_BYTES + 1), Buffer.from('text'), Buffer.alloc(0)]) {
      expect(() => validateImageBytes(bytes)).toThrow(expect.objectContaining({ code: 'IMAGE' }));
    }
  });
});
