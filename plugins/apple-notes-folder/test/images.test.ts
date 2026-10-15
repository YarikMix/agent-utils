import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, symlink, rm, mkdir, truncate, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageSrc, sniffImageMime, MAX_IMAGE_BYTES, defaultImageRoot, validateImageBytes } from '../src/images.js';

// Подмена node:fs/promises целиком (Vitest не даёт spyOn на именованный экспорт ESM-модуля —
// "Module namespace is not configurable"). realpathHolder.impl по умолчанию — настоящий realpath;
// один тест временно подменяет его, чтобы смоделировать гонку между lstat и realpath в src/images.ts.
const realpathHolder = vi.hoisted(() => ({ impl: null as unknown as typeof import('node:fs/promises').realpath }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  realpathHolder.impl = actual.realpath;
  return { ...actual, realpath: (...args: Parameters<typeof actual.realpath>) => realpathHolder.impl(...args) };
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'latin1')]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(8)]);

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'anf-root-'));
  outside = await mkdtemp(join(tmpdir(), 'anf-out-'));
  await writeFile(join(root, 'a.png'), PNG);
  await writeFile(join(root, 'a.jpg'), JPEG);
  await writeFile(join(root, 'a.heic'), HEIC);
  await writeFile(join(root, 'снимок экрана 1.png'), PNG);
  await writeFile(join(root, 'fake.png'), 'просто текст');
  await writeFile(join(outside, 'b.png'), PNG);
  await symlink(join(outside, 'b.png'), join(root, 'link.png'));
  await mkdir(join(root, 'sub'));
  await symlink(outside, join(root, 'sub', 'dirlink'));
  await writeFile(join(root, 'big.png'), PNG);
  await truncate(join(root, 'big.png'), MAX_IMAGE_BYTES + 1);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

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

describe('imageSrc', () => {
  it('принимает настоящие PNG, JPEG и HEIC внутри корня и отдаёт file:// их realpath', async () => {
    for (const name of ['a.png', 'a.jpg', 'a.heic']) {
      const p = join(root, name);
      expect(await imageSrc(p, root)).toBe(pathToFileURL(await realpath(p)).href);
    }
    expect(await imageSrc(join(root, 'a.png'), root)).toMatch(/^file:\/\/\//);
  });

  it('пробелы и кириллица в имени — процентное кодирование', async () => {
    const src = await imageSrc(join(root, 'снимок экрана 1.png'), root);
    expect(src).toContain('%20');
    expect(src).toContain(encodeURIComponent('снимок'));
    expect(src).not.toMatch(/[ а-я]/);
  });

  it('отказывает файлу вне корня', async () => {
    await expect(imageSrc(join(outside, 'b.png'), root)).rejects.toThrow(/должен лежать/);
  });

  it('отказывает символической ссылке', async () => {
    await expect(imageSrc(join(root, 'link.png'), root)).rejects.toThrow(/символическая ссылка/);
  });

  it('отказывает файлу за ссылкой на каталог вне корня', async () => {
    await expect(imageSrc(join(root, 'sub', 'dirlink', 'b.png'), root)).rejects.toThrow(/должен лежать/);
  });

  it('отказывает тексту с расширением .png', async () => {
    await expect(imageSrc(join(root, 'fake.png'), root)).rejects.toThrow(/формат/);
  });

  it('отказывает файлу больше 10 МБ', async () => {
    await expect(imageSrc(join(root, 'big.png'), root)).rejects.toThrow(/10 МБ/);
  });

  it('отказывает относительному пути и несуществующему файлу', async () => {
    await expect(imageSrc('a.png', root)).rejects.toThrow(/абсолютный путь/);
    await expect(imageSrc(join(root, 'nope.png'), root)).rejects.toThrow(/не найден/);
  });

  it('все отказы — ToolError с кодом IMAGE', async () => {
    await expect(imageSrc(join(root, 'fake.png'), root)).rejects.toMatchObject({ code: 'IMAGE' });
  });

  it('корень по умолчанию — временная папка Claude Code текущего пользователя', () => {
    expect(defaultImageRoot()).toBe(`/private/tmp/claude-${process.getuid!()}`);
  });

  it('гонка: файл исчезает между lstat и realpath — понятная ошибка IMAGE «файл не найден», не падение процесса', async () => {
    const p = join(root, 'a.png');
    const trueRealpath = realpathHolder.impl;
    realpathHolder.impl = (async (arg: string) => {
      if (arg === p) throw Object.assign(new Error('ENOENT: race'), { code: 'ENOENT' });
      return trueRealpath(arg);
    }) as typeof realpath;
    try {
      await expect(imageSrc(p, root)).rejects.toMatchObject({ code: 'IMAGE' });
      await expect(imageSrc(p, root)).rejects.toThrow(/не найден/);
    } finally {
      realpathHolder.impl = trueRealpath;
    }
  });
});
