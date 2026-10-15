import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile, mkdir, rename, chmod, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSnapshot, verifySnapshot } from '../src/attachments/snapshots.js';
import type { VerifiedAttachment } from '../src/hosts/types.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const attachment = (bytes = png): VerifiedAttachment => ({ href: 'attachment:one', aliases: [], bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'anf-snapshots-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('private snapshots', () => {
  it('roundtrips each supported format and a full 10 MiB image', async () => {
    const max = Buffer.alloc(10 * 1024 * 1024);
    png.copy(max);
    for (const bytes of [png, Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.from('GIF89a'), Buffer.from('RIFF0000WEBPVP8 '), Buffer.from('00000018667479706865696300000000', 'hex'), max]) {
      const grant = await saveSnapshot(root, attachment(bytes));
      expect((await readFile(fileURLToPath(await verifySnapshot(root, grant)))).equals(bytes)).toBe(true);
    }
  });

  it('stores original bytes in a private content-addressed file', async () => {
    const grant = await saveSnapshot(root, attachment());
    const url = await verifySnapshot(root, grant);
    expect(fileURLToPath(url)).toBe(grant.snapshotPath);
    expect(await readFile(grant.snapshotPath)).toEqual(png);
    expect(grant.snapshotPath).toContain(attachment().sha256);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'snapshots'))).mode & 0o777).toBe(0o700);
    expect((await stat(grant.snapshotPath)).mode & 0o777).toBe(0o600);
  });

  it('refuses corrupt bytes, a false hash, invalid signature and oversized bytes', async () => {
    const grant = await saveSnapshot(root, attachment());
    await writeFile(grant.snapshotPath, Buffer.concat([png, Buffer.from('changed')]));
    await expect(verifySnapshot(root, grant)).rejects.toMatchObject({ code: 'IMAGE' });
    await expect(saveSnapshot(root, { ...attachment(), sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'IMAGE' });
    await expect(saveSnapshot(root, attachment(Buffer.from('text')))).rejects.toMatchObject({ code: 'IMAGE' });
    await expect(saveSnapshot(root, attachment(Buffer.alloc(10 * 1024 * 1024 + 1)))).rejects.toMatchObject({ code: 'IMAGE' });
  });

  it('rejects arbitrary paths, traversal and symlink files', async () => {
    const grant = await saveSnapshot(root, attachment());
    const outside = join(root, 'outside.png');
    await writeFile(outside, png, { mode: 0o600 });
    for (const snapshotPath of [outside, '../outside.png', grant.snapshotPath.replace('/snapshots/', '/snapshots/../snapshots/')]) {
      await expect(verifySnapshot(root, { ...grant, snapshotPath })).rejects.toMatchObject({ code: 'IMAGE' });
    }
    await unlink(grant.snapshotPath);
    await symlink(outside, grant.snapshotPath);
    await expect(verifySnapshot(root, grant)).rejects.toMatchObject({ code: 'IMAGE' });
    await expect(saveSnapshot(root, attachment())).rejects.toMatchObject({ code: 'IMAGE' });
  });

  it('rejects symlink snapshot and runtime directories', async () => {
    const outside = join(root, 'outside');
    const runtime = join(root, 'runtime');
    await mkdir(outside, { mode: 0o700 });
    await mkdir(runtime, { mode: 0o700 });
    await symlink(outside, join(runtime, 'snapshots'));
    await expect(saveSnapshot(runtime, attachment())).rejects.toMatchObject({ code: 'IMAGE' });
    await symlink(outside, join(root, 'linked-runtime'));
    await expect(saveSnapshot(join(root, 'linked-runtime'), attachment())).rejects.toMatchObject({ code: 'IMAGE' });
  });

  it('rejects a replaced directory, hard links and public file permissions', async () => {
    const grant = await saveSnapshot(root, attachment());
    await chmod(grant.snapshotPath, 0o644);
    await expect(verifySnapshot(root, grant)).rejects.toMatchObject({ code: 'IMAGE' });
    await chmod(grant.snapshotPath, 0o600);
    await link(grant.snapshotPath, join(root, 'hardlink'));
    await expect(verifySnapshot(root, grant)).rejects.toMatchObject({ code: 'IMAGE' });
    await unlink(join(root, 'hardlink'));
    await rename(join(root, 'snapshots'), join(root, 'moved'));
    await symlink(join(root, 'moved'), join(root, 'snapshots'));
    await expect(verifySnapshot(root, grant)).rejects.toMatchObject({ code: 'IMAGE' });
  });

  it('uses immutable bytes rather than rereading an alias', async () => {
    const alias = join(root, 'source.png');
    await writeFile(alias, png);
    const grant = await saveSnapshot(root, { ...attachment(), aliases: [alias] });
    await writeFile(alias, 'replaced');
    expect(await readFile(fileURLToPath(await verifySnapshot(root, grant)))).toEqual(png);
  });

  it('concurrent publication leaves a complete verified snapshot', async () => {
    const grants = await Promise.all(Array.from({ length: 8 }, () => saveSnapshot(root, attachment())));
    expect(new Set(grants.map(g => g.snapshotPath)).size).toBe(1);
    for (const grant of grants) await expect(verifySnapshot(root, grant)).resolves.toMatch(/^file:/);
  });
});
