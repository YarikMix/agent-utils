import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, utimes } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolError } from '../errors.js';
import { MAX_IMAGE_BYTES, sniffImageMime, validateImageBytes } from '../images.js';
import type { ImageGrant, VerifiedAttachment } from '../hosts/types.js';

export const SHA256 = /^[a-f0-9]{64}$/;
export const SNAPSHOT_NAME = /^[a-f0-9]{64}\.(png|jpg|gif|heic|webp)$/;
export const PUBLICATION_TEMP_NAME = /^\.tmp-(?:([1-9][0-9]*)-)?[a-f0-9]{64}$/;
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/heic': 'heic', 'image/webp': 'webp' };
const fail = () => new ToolError('IMAGE', 'Не удалось проверить закрытый снимок картинки.');

/** Reject symlinks in every component, including the runtime directory itself. */
export async function privateDirectory(path: string, create = true): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw fail();
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const st = await lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw fail();
    if (current === path && ((st.mode & 0o777) !== 0o700 || st.uid !== process.getuid!())) throw fail();
  }
  if (await realpath(path) !== path) throw fail();
}

/** Bounded reads from a no-follow fd; metadata and hash callers see the same bytes. */
export async function readPrivateFile(path: string, limit: number): Promise<Buffer> {
  await privateDirectory(dirname(path), false);
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o600 || st.size > limit) throw fail();
    if (await realpath(path) !== path) throw fail();
    const bytes = Buffer.alloc(st.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await fh.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await fh.stat();
    if (offset !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw fail();
    return bytes.subarray(0, offset);
  } finally { await fh.close(); }
}

/** The final name is visible only after the complete private file has been synced. */
export async function publishPrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  await privateDirectory(dirname(path));
  // Keep standalone publishers identifiable even when no ticket mutex is held.
  const temporary = join(dirname(path), `.tmp-${process.pid}-${randomBytes(32).toString('hex')}`);
  try {
    const fh = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function validSnapshotPath(runtimeDir: string, grant: ImageGrant): boolean {
  if (!grant || typeof grant.href !== 'string' || typeof grant.sha256 !== 'string' || !SHA256.test(grant.sha256) || typeof grant.snapshotPath !== 'string') return false;
  return Object.values(extensions).some(ext => grant.snapshotPath === join(runtimeDir, 'snapshots', `${grant.sha256}.${ext}`));
}

export async function saveSnapshot(runtimeDir: string, attachment: VerifiedAttachment): Promise<ImageGrant> {
  try {
    // Copy before validation: caller mutation cannot change the bytes being published.
    if (attachment.bytes.byteLength > MAX_IMAGE_BYTES) throw fail();
    const bytes = Buffer.from(attachment.bytes);
    validateImageBytes(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== attachment.sha256) throw fail();
    await privateDirectory(runtimeDir);
    await privateDirectory(join(runtimeDir, 'snapshots'));
    const ext = extensions[sniffImageMime(bytes)!];
    const grant = { href: attachment.href, sha256, snapshotPath: join(runtimeDir, 'snapshots', `${sha256}.${ext}`) };
    const existing = await lstat(grant.snapshotPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing) await verifySnapshot(runtimeDir, grant);
    else await publishPrivateFile(grant.snapshotPath, bytes);
    await utimes(grant.snapshotPath, new Date(), new Date());
    return grant;
  } catch { throw fail(); }
}

export async function verifySnapshot(runtimeDir: string, grant: ImageGrant): Promise<string> {
  try {
    if (!validSnapshotPath(runtimeDir, grant)) throw fail();
    await privateDirectory(runtimeDir, false);
    const bytes = await readPrivateFile(grant.snapshotPath, MAX_IMAGE_BYTES);
    validateImageBytes(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== grant.sha256) throw fail();
    if (grant.snapshotPath !== join(runtimeDir, 'snapshots', `${grant.sha256}.${extensions[sniffImageMime(bytes)!]}`)) throw fail();
    return pathToFileURL(grant.snapshotPath).href;
  } catch { throw fail(); }
}
