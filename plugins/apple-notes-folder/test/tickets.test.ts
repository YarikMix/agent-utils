import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, readdir, stat, writeFile, symlink, unlink, mkdir } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeTicket, issueTicket, cleanupRuntime } from '../src/attachments/tickets.js';
import type { AttachmentContext, RuntimePaths, VerifiedAttachment, WriteArgs, Host, WriteToolName } from '../src/hosts/types.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const image: VerifiedAttachment = { href: 'attachment:one', aliases: ['/original.png'], bytes: png, sha256: createHash('sha256').update(png).digest('hex') };
const context: AttachmentContext = { host: 'codex', sessionId: 'session', callId: 'call', transcriptPath: '/unused' };
const args: WriteArgs = { title: 'test', markdown: '![](attachment:one)' };
const DAY = 86400000;
let paths: RuntimePaths;
beforeEach(async () => { paths = { configFile: null, runtimeDir: await realpath(await mkdtemp(join(tmpdir(), 'anf-tickets-'))) }; });
afterEach(async () => { await rm(paths.runtimeDir, { recursive: true, force: true }); });
const issue = (input = args, now = 1000) => issueTicket(paths, context, 'notes_create', input, [image], () => now);
const input = (ticket: string) => ({ ...args, attachment_ticket: ticket });
const manifestPath = (ticket: string, dir = 'tickets') => join(paths.runtimeDir, dir, `${ticket}.json`);

// Each invocation is a distinct Node process sharing only the actual runtime filesystem.
async function childDriver(): Promise<string> {
  const driver = join(paths.runtimeDir, 'driver.mjs');
  await build({ stdin: { contents: `
    import { consumeTicket, issueTicket, cleanupRuntime } from './src/attachments/tickets.ts';
    const [root, action, payload] = process.argv.slice(2);
    const data = JSON.parse(payload);
    const paths = {runtimeDir: root, configFile: null};
    try {
      if (action === 'consume') {
        const lease = await consumeTicket(paths, 'codex', 'notes_create', data, () => 1001);
        console.log(JSON.stringify({ok: true, images: lease.images.length}));
        await lease.release();
      } else if (action === 'issue') {
        data.image.bytes = Buffer.from(data.image.bytes, 'base64');
        console.log(JSON.stringify({ok: true, ticket: await issueTicket(paths, data.context, 'notes_create', data.args, [data.image], () => data.now)}));
      } else {
        await cleanupRuntime(paths, () => data.now);
        console.log(JSON.stringify({ok: true}));
      }
    } catch (error) { console.log(JSON.stringify({ok: false, code: error.code})); }
  `, resolveDir: process.cwd(), sourcefile: 'driver.ts' }, bundle: true, platform: 'node', format: 'esm', outfile: driver });
  return driver;
}
const runChild = async (driver: string, action: string, payload: unknown) => JSON.parse((await promisify(execFile)(process.execPath, [driver, paths.runtimeDir, action, JSON.stringify(payload)])).stdout);

describe('one-use exact-call tickets', () => {
  it('issues the versioned manifest last, with a 15 minute lifetime and private modes', async () => {
    const ticket = await issue();
    expect(ticket).toMatch(/^[a-f0-9]{64}$/);
    const manifest = JSON.parse(await readFile(manifestPath(ticket), 'utf8'));
    expect(manifest).toMatchObject({ version: 1, host: 'codex', sessionId: 'session', callId: 'call', tool: 'notes_create', issuedAt: 1000, expiresAt: 901000 });
    expect(manifest.images).toHaveLength(1);
    expect(manifest.argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(manifestPath(ticket))).mode & 0o777).toBe(0o600);
    expect((await stat(join(paths.runtimeDir, 'tickets'))).mode & 0o777).toBe(0o700);
    const lease = await consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001);
    expect(lease.images).toHaveLength(1);
    const active = JSON.parse(await readFile(manifestPath(ticket, 'active'), 'utf8'));
    expect(active).toMatchObject({ pid: process.pid, claimedAt: 1001 });
    await lease.release();
    await lease.release();
    expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([]);
    await expect(consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1002)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
  });

  it('accepts reordered argument keys and grants each used alias only once', async () => {
    const markdown = '![](/original.png) ![](attachment:one) ![](/original.png)';
    const ticket = await issue({ title: 'test', markdown });
    const lease = await consumeTicket(paths, 'codex', 'notes_create', { markdown, attachment_ticket: ticket, title: 'test' }, () => 1001);
    expect(lease.images.map(g => g.href)).toEqual(['/original.png', 'attachment:one']);
    expect(new Set(lease.images.map(g => g.snapshotPath)).size).toBe(1);
    await lease.release();
  });

  it('recursively canonicalizes nested JSON keys while binding unknown argument values', async () => {
    const nested = { ...args, extra: { b: [1, { d: 2, c: 3 }], a: true } };
    const ticket = await issue(nested);
    const reordered = { extra: { a: true, b: [1, { c: 3, d: 2 }] }, ...input(ticket) };
    const lease = await consumeTicket(paths, 'codex', 'notes_create', reordered, () => 1001);
    await lease.release();
    const other = await issue(nested);
    await expect(consumeTicket(paths, 'codex', 'notes_create', { ...input(other), extra: { a: false } } as WriteArgs, () => 1001)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
  });

  it('refuses conflicting aliases instead of choosing arbitrary attachment bytes', async () => {
    await expect(issueTicket(paths, context, 'notes_create', args, [image, { ...image, sha256: '0'.repeat(64) }], () => 1000)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it.each([
    ['claude', 'notes_create', args, 1001],
    ['unknown', 'notes_create', args, 1001],
    ['codex', 'notes_append', args, 1001],
    ['codex', 'unknown', args, 1001],
    ['codex', 'notes_create', { ...args, markdown: args.markdown + '\n' }, 1001],
    ['codex', 'notes_create', args, 901000],
    ['codex', 'notes_create', args, 901001],
  ])('rejects mismatched or expired calls (%s %s %j %s)', async (host, tool, changed, time) => {
    const ticket = await issue();
    await expect(consumeTicket(paths, host as Host, tool as WriteToolName, { ...changed, attachment_ticket: ticket }, () => time)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
  });

  it('rejects unknown/missing/path-like ticket identifiers', async () => {
    for (const ticket of [undefined, '', '../x', '/tmp/x', '0'.repeat(64), 'a'.repeat(64) + '.json']) {
      await expect(consumeTicket(paths, 'codex', 'notes_create', { ...args, attachment_ticket: ticket }, () => 1001)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    }
  });

  it('only one of concurrent consumers can claim the ticket', async () => {
    const ticket = await issue();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001)));
    const successful = results.filter(r => r.status === 'fulfilled');
    expect(successful).toHaveLength(1);
    for (const result of results) if (result.status === 'fulfilled') await result.value.release();
  });

  it('allows exactly one claimant across separate Node processes', async () => {
    const ticket = await issue();
    const driver = await childDriver();
    const results = await Promise.all(Array.from({ length: 8 }, () => runChild(driver, 'consume', input(ticket))));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.code === 'IMAGE_TICKET')).toHaveLength(7);
    expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([]);
  });

  it('serializes cleanup against publication of a reused snapshot in separate processes', async () => {
    const old = await issue();
    const snapshot = JSON.parse(await readFile(manifestPath(old), 'utf8')).images[0].snapshotPath;
    const driver = await childDriver();
    const time = DAY * 2;
    const data = { context, args, image: { ...image, bytes: png.toString('base64') }, now: time };
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => runChild(driver, 'issue', data)),
      ...Array.from({ length: 4 }, () => runChild(driver, 'cleanup', { now: time })),
    ]);
    expect(results.filter(r => r.ok)).toHaveLength(8);
    expect(await readFile(snapshot)).toEqual(png);
    for (const result of results.filter(r => r.ticket)) {
      const lease = await consumeTicket(paths, 'codex', 'notes_create', input(result.ticket), () => time + 1);
      expect(lease.images).toHaveLength(1);
      await lease.release();
    }
  });

  it('recovers a dead mutex owner without reclaiming an ambiguous lock', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    const lock = join(paths.runtimeDir, '.lock');
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, `owner-${dead.pid}-${'a'.repeat(64)}.json`), JSON.stringify({ pid: dead.pid }), { mode: 0o600 });
    expect(await issue()).toMatch(/^[a-f0-9]{64}$/);
    await mkdir(lock, { mode: 0o700 });
    await expect(issue()).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    expect(await stat(lock)).toBeTruthy();
    await rm(lock, { recursive: true });
    expect(await issue()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('unknown href or bad later attachment publishes no ticket', async () => {
    await expect(issue({ ...args, markdown: args.markdown + ' ![](unknown)' })).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
    const invalid = { ...image, href: 'attachment:bad', bytes: Buffer.from('text') };
    await expect(issueTicket(paths, context, 'notes_create', { ...args, markdown: args.markdown + ' ![](attachment:bad)' }, [image, invalid], () => 1000)).rejects.toThrow();
    expect(await readdir(join(paths.runtimeDir, 'tickets')).catch(() => [])).toEqual([]);
  });

  it('does not grant or save unused attachments', async () => {
    const ticket = await issueTicket(paths, context, 'notes_create', args, [image, { ...image, href: 'unused', bytes: Buffer.from('invalid') }], () => 1000);
    const lease = await consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001);
    expect(lease.images).toHaveLength(1);
    await lease.release();
  });

  it('rejects malformed manifests before following any embedded path', async () => {
    for (const change of [{ version: 2 }, { images: {} }, { host: 'other' }, { expiresAt: Infinity }, { images: [{ href: image.href, sha256: image.sha256, snapshotPath: '/outside' }] }]) {
      const ticket = await issue();
      const path = manifestPath(ticket);
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...manifest, ...change }));
      await expect(consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    }
  });

  it('rejects symlink ticket and releases the active marker if snapshot verification fails', async () => {
    const ticket = await issue();
    const manifest = JSON.parse(await readFile(manifestPath(ticket), 'utf8'));
    await writeFile(manifest.images[0].snapshotPath, Buffer.concat([png, Buffer.from('tampered')]));
    await expect(consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001)).rejects.toThrow();
    expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([]);
    await expect(consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1002)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    const other = await issueTicket(paths, context, 'notes_create', { markdown: 'text' }, [], () => 1000);
    const outside = join(paths.runtimeDir, 'outside.json');
    await writeFile(outside, await readFile(manifestPath(other)), { mode: 0o600 });
    await unlink(manifestPath(other));
    await symlink(outside, manifestPath(other));
    await expect(consumeTicket(paths, 'codex', 'notes_create', { markdown: 'text', attachment_ticket: other }, () => 1001)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
  });
});

describe('runtime cleanup', () => {
  it('conservatively retains snapshots for an unreadable active owner', async () => {
    const ticket = await issue();
    const lease = await consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001);
    await writeFile(manifestPath(ticket, 'active'), '{broken-json');
    await cleanupRuntime(paths, () => DAY * 2);
    expect(await readFile(lease.images[0].snapshotPath)).toEqual(png);
    await lease.release();
  });

  it('preserves live active claims past 24h, then expires their own files after release', async () => {
    const ticket = await issue();
    const lease = await consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001);
    const snapshot = lease.images[0].snapshotPath;
    const unrelated = join(paths.runtimeDir, 'snapshots', 'unrelated.txt');
    await writeFile(unrelated, 'keep');
    await cleanupRuntime(paths, () => DAY * 2);
    expect(await readFile(snapshot)).toEqual(png);
    expect(await stat(manifestPath(ticket, 'active'))).toBeTruthy();
    await lease.release();
    await cleanupRuntime(paths, () => DAY * 2);
    await expect(stat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  });

  it('retains fresh/reused hashes and unexpired tickets, removes expired tickets', async () => {
    const first = await issue();
    const snapshot = JSON.parse(await readFile(manifestPath(first), 'utf8')).images[0].snapshotPath;
    const second = await issue(args, DAY - 1);
    await cleanupRuntime(paths, () => DAY + 1001);
    expect(await readFile(snapshot)).toEqual(png);
    await expect(stat(manifestPath(first))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(manifestPath(second))).toBeTruthy();
    await cleanupRuntime(paths, () => DAY * 2);
    await expect(stat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains recent orphan claims, cleans dead owners only after 24 hours', async () => {
    const ticket = await issue();
    const lease = await consumeTicket(paths, 'codex', 'notes_create', input(ticket), () => 1001);
    const activePath = manifestPath(ticket, 'active');
    const marker = JSON.parse(await readFile(activePath, 'utf8'));
    // An exited child gives a real absent PID, rather than mocking process liveness.
    const dead = spawnSync(process.execPath, ['-e', '']);
    await writeFile(activePath, JSON.stringify({ ...marker, pid: dead.pid }));
    await cleanupRuntime(paths, () => DAY);
    expect(await stat(activePath)).toBeTruthy();
    await cleanupRuntime(paths, () => DAY + 1001);
    await expect(stat(activePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(lease.images[0].snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
