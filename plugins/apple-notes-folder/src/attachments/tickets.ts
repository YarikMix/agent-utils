import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rmdir, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolError, reportAttachmentCleanupFailure } from '../errors.js';
import { imageHrefs } from '../markdown.js';
import type { AttachmentContext, Clock, Host, ImageGrant, PreparedImages, RuntimePaths, TicketLease, VerifiedAttachment, WriteArgs, WriteToolName } from '../hosts/types.js';
import { privateDirectory, publishPrivateFile, readPrivateFile, saveSnapshot, SHA256, SNAPSHOT_NAME, PUBLICATION_TEMP_NAME, validSnapshotPath, verifySnapshot } from './snapshots.js';

const TICKET_TTL = 900000;
const SNAPSHOT_TTL = 86400000;
const JSON_LIMIT = 8 * 1024 * 1024;
const TICKET_NAME = /^[a-f0-9]{64}\.json$/;
const fail = () => new ToolError('IMAGE_TICKET', 'Допуск картинки недействителен, истёк или уже использован. Повторите вызов с новым допуском.');
const validHost = (host: unknown): host is Host => host === 'claude' || host === 'codex';
const validTool = (tool: unknown): tool is WriteToolName => ['notes_create', 'notes_append', 'notes_update'].includes(tool as string);
type Manifest = { version: 1; host: Host; sessionId: string; callId: string; tool: WriteToolName; argsHash: string; issuedAt: number; expiresAt: number; images: ImageGrant[] };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    if (json === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw fail();
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw fail();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function argsHash(args: WriteArgs): string {
  if (!args || typeof args.markdown !== 'string') throw fail();
  const { attachment_ticket: _ticket, ...original } = args;
  return createHash('sha256').update(canonical(original)).digest('hex');
}

function parseManifest(value: unknown, root: string): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const m = value as Manifest;
  if (m.version !== 1 || !validHost(m.host) || !validTool(m.tool) || typeof m.sessionId !== 'string' || !m.sessionId ||
      typeof m.callId !== 'string' || !m.callId || typeof m.argsHash !== 'string' || !SHA256.test(m.argsHash) ||
      !Number.isSafeInteger(m.issuedAt) || !Number.isSafeInteger(m.expiresAt) || m.expiresAt !== m.issuedAt + TICKET_TTL ||
      !Array.isArray(m.images) || !m.images.every(image => validSnapshotPath(root, image)) ||
      new Set(m.images.map(image => image.href)).size !== m.images.length) throw fail();
  return m;
}

const readJson = async (path: string): Promise<unknown> => JSON.parse((await readPrivateFile(path, JSON_LIMIT)).toString('utf8'));
const publishJson = async (path: string, value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > JSON_LIMIT) throw fail();
  await publishPrivateFile(path, bytes);
};
const file = (root: string, dir: string, ticket: string) => join(root, dir, `${ticket}.json`);
const remove = async (path: string) => { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); };

/** EPERM and all ambiguous states are treated as a potentially live owner. */
function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Only the reaper which removes this exact dead owner's unique file may remove the directory. */
async function recoverDeadLock(lock: string): Promise<void> {
  try {
    await privateDirectory(lock, false);
    const names = await readdir(lock);
    if (names.length !== 1 || !/^owner-[1-9][0-9]*-[a-f0-9]{64}\.json$/.test(names[0])) return;
    const owner = await readJson(join(lock, names[0])) as { pid?: unknown };
    if (!Number.isSafeInteger(owner?.pid) || (owner.pid as number) <= 0 || !names[0].startsWith(`owner-${owner.pid}-`) || ownerAlive(owner.pid as number)) return;
    await unlink(join(lock, names[0]));
    await rmdir(lock);
  } catch { /* Another reaper won, or the owner is ambiguous: never remove an unrecognized lock. */ }
}

/** Serialize publication, claim and garbage collection across independent Node processes. */
async function locked<T>(paths: RuntimePaths, action: () => Promise<T>): Promise<T> {
  const root = paths.runtimeDir;
  try { await privateDirectory(root); }
  catch { throw fail(); }
  const lock = join(root, '.lock');
  const owner = join(lock, `owner-${process.pid}-${randomBytes(32).toString('hex')}.json`);
  const deadline = Date.now() + 2000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fail();
      await recoverDeadLock(lock);
      if (Date.now() >= deadline) throw new ToolError('IMAGE_TICKET', 'Хранилище картинок занято или его lock требует проверки. Повторите вызов позже.');
      await delay(10);
    }
  }
  try {
    await publishJson(owner, { pid: process.pid, createdAt: Date.now() });
    for (const dir of ['snapshots', 'tickets', 'consumed', 'active']) await privateDirectory(join(root, dir));
    return await action();
  } finally {
    await remove(owner);
    await rmdir(lock);
  }
}

export async function issueTicket(paths: RuntimePaths, context: AttachmentContext, name: WriteToolName, args: WriteArgs, attachments: VerifiedAttachment[], now: Clock = Date.now): Promise<string> {
  if (!validHost(context.host) || !context.sessionId || !context.callId || !validTool(name)) throw fail();
  const hash = argsHash(args);
  // Resolve every href before writing anything. Ambiguous aliases must not select arbitrary bytes.
  const selected = imageHrefs(args.markdown).map(href => {
    const matches = attachments.filter(a => a.href === href || a.aliases.includes(href));
    if (!matches.length || matches.some(a => a.sha256 !== matches[0].sha256)) throw new ToolError('IMAGE_PROVENANCE', 'Картинка не подтверждена вложением текущего диалога.');
    return { ...matches[0], href };
  });
  return locked(paths, async () => {
    const issuedAt = now();
    const images: ImageGrant[] = [];
    for (const attachment of selected) {
      const grant = await saveSnapshot(paths.runtimeDir, attachment);
      // Retention starts again with every issuance, including content-addressed reuse.
      await utimes(grant.snapshotPath, new Date(issuedAt), new Date(issuedAt));
      images.push(grant);
    }
    const manifest = parseManifest({ version: 1, host: context.host, sessionId: context.sessionId, callId: context.callId, tool: name, argsHash: hash, issuedAt, expiresAt: issuedAt + TICKET_TTL, images }, paths.runtimeDir);
    const ticket = randomBytes(32).toString('hex');
    await publishJson(file(paths.runtimeDir, 'tickets', ticket), manifest);
    return ticket;
  });
}

export async function consumeTicket(paths: RuntimePaths, host: Host, name: WriteToolName, args: WriteArgs, now: Clock = Date.now): Promise<TicketLease> {
  const ticket = args?.attachment_ticket;
  if (typeof ticket !== 'string' || !SHA256.test(ticket) || !validHost(host) || !validTool(name)) throw fail();
  const hash = argsHash(args);
  return locked(paths, async () => {
    const root = paths.runtimeDir;
    let manifest: Manifest;
    const claimedAt = now();
    try {
      manifest = parseManifest(await readJson(file(root, 'tickets', ticket)), root);
      if (!Number.isSafeInteger(claimedAt) || manifest.host !== host || manifest.tool !== name || manifest.argsHash !== hash || claimedAt >= manifest.expiresAt || claimedAt < manifest.issuedAt ||
          canonical(manifest.images.map(image => image.href)) !== canonical(imageHrefs(args.markdown))) throw fail();
      await rename(file(root, 'tickets', ticket), file(root, 'consumed', ticket));
    } catch { throw fail(); }
    const active = file(root, 'active', ticket);
    let released = false;
    const release = async () => {
      if (released) return;
      await privateDirectory(join(root, 'active'), false);
      await remove(active);
      released = true;
    };
    try {
      await publishJson(active, { ...manifest, pid: process.pid, claimedAt });
      for (const grant of manifest.images) await verifySnapshot(root, grant);
      return { images: manifest.images, release };
    } catch (error) {
      try { await release(); } catch { reportAttachmentCleanupFailure(); }
      throw error;
    }
  });
}

export async function cleanupRuntime(paths: RuntimePaths, now: Clock = Date.now): Promise<void> {
  await locked(paths, async () => {
    const root = paths.runtimeDir;
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp)) throw fail();
    const protectedPaths = new Set<string>();
    let uncertain = false;
    for (const dir of ['tickets', 'active', 'consumed']) {
      for (const name of await readdir(join(root, dir))) {
        if (!TICKET_NAME.test(name)) continue;
        const path = join(root, dir, name);
        try {
          const raw = await readJson(path);
          const manifest = parseManifest(raw, root);
          if (dir === 'active') {
            const marker = raw as { pid: number; claimedAt: number };
            if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0 || !Number.isSafeInteger(marker.claimedAt)) { uncertain = true; continue; }
            if (ownerAlive(marker.pid) || timestamp - marker.claimedAt < SNAPSHOT_TTL) {
              for (const image of manifest.images) protectedPaths.add(image.snapshotPath);
            } else await remove(path);
          } else if (dir === 'tickets' && timestamp < manifest.expiresAt) {
            for (const image of manifest.images) protectedPaths.add(image.snapshotPath);
          } else if (dir === 'tickets' || timestamp - manifest.issuedAt >= SNAPSHOT_TTL) {
            await remove(path);
          }
        } catch { uncertain = true; /* Do not infer references from malformed or inaccessible registries. */ }
      }
    }
    if (uncertain) return;
    for (const name of await readdir(join(root, 'snapshots'))) {
      const temporary = PUBLICATION_TEMP_NAME.exec(name);
      if (!SNAPSHOT_NAME.test(name) && !temporary) continue;
      if (temporary?.[1]) {
        const pid = Number(temporary[1]);
        if (!Number.isSafeInteger(pid) || ownerAlive(pid)) continue;
      }
      // Legacy temporaries have no PID; their production publishers held this same mutex.
      // New standalone publishers are protected above, including ambiguous owner liveness.
      const path = join(root, 'snapshots', name);
      const st = await lstat(path);
      if (!protectedPaths.has(path) && st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid!() &&
          (st.mode & 0o777) === 0o600 && st.nlink === 1 && timestamp - st.mtimeMs >= SNAPSHOT_TTL) await remove(path);
    }
  });
}

/** Resolve only verified grants; text-only calls never consume a ticket or read a file. */
export function makeImagePreparer(host: Host, paths: RuntimePaths, now: Clock = Date.now): (name: WriteToolName, args: WriteArgs) => Promise<PreparedImages> {
  return async (name, args) => {
    if (!imageHrefs(args.markdown).length) return { snapshotPaths: [], resolve: async () => { throw fail(); }, release: async () => {} };
    const lease = await consumeTicket(paths, host, name, args, now);
    try {
      const urls = new Map<string, string>();
      for (const grant of lease.images) urls.set(grant.href, await verifySnapshot(paths.runtimeDir, grant));
      return {
        snapshotPaths: [...new Set(lease.images.map(grant => grant.snapshotPath))],
        resolve: async href => { const url = urls.get(href); if (!url) throw fail(); return url; },
        release: lease.release,
      };
    } catch (error) {
      try { await lease.release(); } catch { reportAttachmentCleanupFailure(); }
      throw error;
    }
  };
}
