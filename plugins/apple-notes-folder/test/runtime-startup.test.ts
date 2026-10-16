import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { issueTicket, consumeTicket } from '../src/attachments/tickets.js';
import { hostPaths } from '../src/hosts/paths.js';
import type { Host } from '../src/hosts/types.js';

let dir: string;
let env: Record<string, string>;
const server = fileURLToPath(new URL('../dist/server.js', import.meta.url));
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'notes-startup-')));
  env = { HOME: dir, CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), NOTES_FOLDER: '' };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function start(host: Host) {
  const client = new Client({ name: 'maintenance-regression', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--client', host], env, stderr: 'pipe' });
  let diagnostic = '';
  transport.stderr?.on('data', chunk => { diagnostic += chunk.toString(); });
  await client.connect(transport);
  return { client, diagnostic: () => diagnostic };
}
async function image(host: Host, label: string, timestamp: number, active = false) {
  const paths = hostPaths(host, env, dir);
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(label)]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const args = { title: label, markdown: `![](attachment:${sha256})` };
  const ticket = await issueTicket(paths, { host, sessionId: 's', callId: label, transcriptPath: '' }, 'notes_create', args,
    [{ bytes, sha256, href: `attachment:${sha256}`, aliases: [] }], () => timestamp);
  if (active) await consumeTicket(paths, host, 'notes_create', { ...args, attachment_ticket: ticket }, () => timestamp);
  return { ticket, snapshot: join(paths.runtimeDir, 'snapshots', `${sha256}.png`) };
}
it.each(['codex', 'claude'] as const)('%s bundled startup deletes expired unprotected state and preserves fresh/live and other host', async host => {
  const oldTime = Date.now() - 2 * 86400000;
  const paths = hostPaths(host, env, dir);
  const old = await image(host, 'expired', oldTime);
  const consumed = await image(host, 'consumed', oldTime, true);
  await rm(join(paths.runtimeDir, 'active', `${consumed.ticket}.json`));
  const active = await image(host, 'live owner', oldTime, true);
  const fresh = await image(host, 'fresh ticket', Date.now());
  await utimes(fresh.snapshot, new Date(oldTime), new Date(oldTime));
  const otherHost = host === 'claude' ? 'codex' : 'claude';
  const other = await image(otherHost, 'other host expired', oldTime);
  const { client } = await start(host);
  try {
    expect((await client.listTools()).tools).toHaveLength(7);
    await expect(stat(old.snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(consumed.snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(paths.runtimeDir, 'tickets'))).toEqual([`${fresh.ticket}.json`]);
    expect(await readdir(join(paths.runtimeDir, 'consumed'))).toEqual([]);
    expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([`${active.ticket}.json`]);
    for (const kept of [active, fresh, other]) expect((await stat(kept.snapshot)).isFile()).toBe(true);
    expect(await readdir(join(hostPaths(otherHost, env, dir).runtimeDir, 'tickets'))).toEqual([`${other.ticket}.json`]);
  } finally { await client.close(); }
});
it.each(['busy', 'ambiguous', 'unsafe-root'] as const)('bundled startup keeps text MCP available with %s runtime and reports only a safe diagnostic', async state => {
  const paths = hostPaths('codex', env, dir);
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  if (state === 'unsafe-root') {
    await rm(paths.runtimeDir, { recursive: true });
    await writeFile(paths.runtimeDir, 'PRIVATE_RUNTIME_CONTENT');
  } else {
    const lock = join(paths.runtimeDir, '.lock');
    await mkdir(lock, { mode: 0o700 });
    if (state === 'busy') await writeFile(join(lock, `owner-${process.pid}-${'a'.repeat(64)}.json`), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    else await writeFile(join(lock, 'PRIVATE_BROKEN_OWNER'), 'PRIVATE_RUNTIME_CONTENT', { mode: 0o600 });
  }
  const { client, diagnostic } = await start('codex');
  try {
    expect((await client.listTools()).tools).toHaveLength(7);
    const result = await client.callTool({ name: 'notes_create', arguments: { title: 'text', markdown: 'text only' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Не задана');
    expect(JSON.stringify(result)).not.toContain('lock');
    expect(diagnostic()).toContain('attachment cleanup failed');
    expect(diagnostic()).not.toMatch(/PRIVATE_|notes-startup-/);
    if (state !== 'unsafe-root') expect((await stat(join(paths.runtimeDir, '.lock'))).isDirectory()).toBe(true);
    else expect(await readFile(paths.runtimeDir, 'utf8')).toBe('PRIVATE_RUNTIME_CONTENT');
  } finally { await client.close(); }
});
