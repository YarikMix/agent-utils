import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../src/hook.js';
import { issueTicket, makeImagePreparer } from '../src/attachments/tickets.js';
import { ToolError, MESSAGES } from '../src/errors.js';
import * as snapshots from '../src/attachments/snapshots.js';
import { makeTools } from '../src/tools.js';
import type { Host, RuntimePaths, WriteArgs, WriteToolName } from '../src/hosts/types.js';
import type { Runner } from '../src/runner.js';

const hash = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';
const href = `attachment:${hash}`;
const prefixes = { codex: 'mcp__apple_notes_folder__', claude: 'mcp__plugin_apple-notes-folder_apple-notes-folder__' };
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/hosts/${name}.json`, import.meta.url), 'utf8'));
let dir: string;
let paths: RuntimePaths;
let timestamp: number;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'notes-integration-')));
  paths = { configFile: null, runtimeDir: join(dir, 'runtime') };
  timestamp = 1792104000000;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const now = () => timestamp;

async function event(host: Host, name: WriteToolName, args: WriteArgs) {
  const original = await fixture(host);
  // Claude tool envelope synthetic/documented; saved user bytes are real auth-free observations.
  const records = host === 'claude' ? (await fixture('claude-authfailed-transcript')).transcriptRecords
    : original.transcriptRecords.slice(original.transcriptRecords.findLastIndex((r: any) => r.type === 'session_meta'));
  const transcript_path = join(dir, `${host}.jsonl`);
  await writeFile(transcript_path, records.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n');
  const raw = host === 'claude' ? original.userPromptSubmit : original.preToolUse.at(-1);
  return { ...raw, session_id: host === 'claude' ? original.userPromptSubmit.session_id : records[0].payload.id,
    transcript_path, hook_event_name: 'PreToolUse', tool_use_id: 'own-call', tool_name: `${prefixes[host]}${name}`, tool_input: args };
}
function tools(host: Host = 'codex', failure?: ToolError, cleanupFailure = false) {
  const writes: string[] = [];
  const scope = vi.fn(async () => ({ folderId: 'F1', folderName: 'F' }));
  const run: Runner = async (_script, args, options) => {
    expect(options.write).toBe(true);
    writes.push(await readFile(args.at(-1)!, 'utf8'));
    if (failure) throw failure;
    return JSON.stringify({ id: 'N1' });
  };
  const prepare = makeImagePreparer(host, paths, now);
  const handlers = makeTools({ getScope: scope, run, prepareImages: async (name, args) => {
    const images = await prepare(name, args);
    return cleanupFailure ? { ...images, release: async () => { throw new Error('PRIVATE_PATH PRIVATE_TICKET'); } } : images;
  } });
  return { writes, scope, handler: (name: string) => handlers.find(t => t.name === name)!.handler };
}
async function hooked(host: Host, name: WriteToolName, args: WriteArgs) {
  const call = await event(host, name, args);
  const output = JSON.parse(await runHook(host, JSON.stringify(call), paths, now));
  expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
  return output.hookSpecificOutput.updatedInput as WriteArgs;
}

// Host-contract status stays distinct: only Codex PreToolUse was captured with a model login.
describe.each(['codex', 'claude'] as const)('%s hook → registered handler (Claude synthetic/documented envelope)', host => {
  it.each(['notes_create', 'notes_append', 'notes_update'] as const)('%s accepts hook ticket once and rejects arbitrary files', async name => {
    const { handler, writes } = tools(host);
    const args = { title: 'Тест', id: 'N1', markdown: `![](${href})` };
    await expect(handler(name)({ ...args, markdown: '![](/private/tmp/claude-1/arbitrary.png)' })).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    expect(writes).toHaveLength(0);
    const updated = await hooked(host, name, args);
    await handler(name)(updated);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('file://');
    expect(writes[0]).toContain('/snapshots/');
    await expect(handler(name)(updated)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    expect(writes).toHaveLength(1);
    expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([]);
  });

  it('hash matches all product args, including title and id, without consuming on mismatch', async () => {
    const { handler, writes } = tools(host);
    const updated = await hooked(host, 'notes_create', { title: 'Original', id: 'N1', markdown: `![](${href})` });
    for (const changed of [{ title: 'Changed' }, { id: 'N2' }, { extra: 'injected' }]) {
      await expect(handler('notes_create')({ ...updated, ...changed })).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    }
    expect(writes).toHaveLength(0);
    await handler('notes_create')(updated);
    expect(writes).toHaveLength(1);
  });

  it('rejects an expired ticket before Notes or scope resolution', async () => {
    const { handler, writes, scope } = tools(host);
    const args = await hooked(host, 'notes_create', { title: 'T', markdown: `![](${href})` });
    timestamp += 900000;
    await expect(handler('notes_create')(args)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    expect(writes).toHaveLength(0);
    expect(scope).not.toHaveBeenCalled();
  });

  it('TIMEOUT_WRITE consumes the ticket and removes active marker; retry needs a fresh hook ticket', async () => {
    const error = new ToolError('TIMEOUT_WRITE', MESSAGES.TIMEOUT_WRITE);
    const { handler, writes } = tools(host, error);
    const args = { title: 'T', markdown: `![](${href})` };
    const updated = await hooked(host, 'notes_create', args);
    await expect(handler('notes_create')(updated)).rejects.toBe(error);
    expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([]);
    await expect(handler('notes_create')(updated)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    expect(writes).toHaveLength(1);
    const fresh = await hooked(host, 'notes_create', args);
    expect(fresh.attachment_ticket).not.toBe(updated.attachment_ticket);
    await expect(handler('notes_create')(fresh)).rejects.toBe(error);
    expect(writes).toHaveLength(2);
  });

  it('Markdown references need tickets, while code fences, raw HTML and text work without transcript', async () => {
    const { handler, writes } = tools(host);
    await expect(handler('notes_create')({ title: 'T', markdown: `![photo][p]\n\n[p]: ${href}` })).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    for (const markdown of ['plain text', '```md\n![](/private/tmp/SECRET.png)\n```', '<img src="/private/tmp/SECRET.png">']) {
      const call = await event(host, 'notes_create', { title: 'T', markdown });
      await rm(call.transcript_path);
      expect(await runHook(host, JSON.stringify(call), paths, now)).toBe('');
      await handler('notes_create')(call.tool_input);
    }
    expect(writes).toHaveLength(3);
    expect(writes[2]).toContain('&lt;img');
    expect(writes[2]).not.toContain('<img');
    await expect(readdir(paths.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it.each(['notes_create', 'notes_append', 'notes_update'] as const)('%s validates every image before NotesService, rejects tampered snapshot, consumes ticket', async name => {
  const bytesA = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const bytesB = Buffer.concat([bytesA, Buffer.from('second')]);
  const attachments = [bytesA, bytesB].map((bytes, i) => ({ href: `attachment:${i}`, aliases: [], bytes, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const args = { title: 'T', id: 'N1', markdown: attachments.map(a => `![](${a.href})`).join('\n') };
  const ticket = await issueTicket(paths, { host: 'codex', sessionId: 's', callId: 'c', transcriptPath: '' }, name, args, attachments, now);
  await writeFile(join(paths.runtimeDir, 'snapshots', `${attachments[1].sha256}.png`), 'tampered');
  const { handler, writes, scope } = tools();
  await expect(handler(name)({ ...args, attachment_ticket: ticket })).rejects.toMatchObject({ code: 'IMAGE' });
  expect(writes).toHaveLength(0);
  expect(scope).not.toHaveBeenCalled();
  expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([]);
  await expect(handler(name)({ ...args, attachment_ticket: ticket })).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
});

it.each(['success', 'TIMEOUT_WRITE', 'OUTSIDE'] as const)('cleanup failure preserves %s and retains consumed ticket/active registry', async outcome => {
  const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const failure = outcome === 'success' ? undefined : new ToolError(outcome, outcome === 'TIMEOUT_WRITE' ? MESSAGES.TIMEOUT_WRITE : MESSAGES.OUTSIDE);
  const { handler, writes } = tools('codex', failure, true);
  const args = await hooked('codex', 'notes_create', { title: 'T', markdown: `![](${href})` });
  if (failure) await expect(handler('notes_create')(args)).rejects.toBe(failure);
  else expect(JSON.parse(await handler('notes_create')(args))).toEqual({ id: 'N1' });
  expect(writes).toHaveLength(1);
  expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([`${args.attachment_ticket}.json`]);
  expect(await readdir(join(paths.runtimeDir, 'consumed'))).toEqual([`${args.attachment_ticket}.json`]);
  await expect(handler('notes_create')(args)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
  expect(writes).toHaveLength(1);
  expect(diagnostic.mock.calls.flat().join('')).toBe('apple-notes-folder: attachment cleanup failed; retained for later cleanup.\n');
});

it('resolver construction failure releases the lease and keeps the original error', async () => {
  const args = await hooked('codex', 'notes_create', { title: 'T', markdown: `![](${href})` });
  const original = snapshots.verifySnapshot;
  const failure = new ToolError('IMAGE', 'snapshot validation failed');
  let calls = 0;
  vi.spyOn(snapshots, 'verifySnapshot').mockImplementation(async (...params) => {
    if (++calls === 2) throw failure; // Consume validates first; preparer then builds the verified resolver.
    return original(...params);
  });
  const { handler, writes } = tools();
  await expect(handler('notes_create')(args)).rejects.toBe(failure);
  expect(calls).toBe(2);
  expect(writes).toHaveLength(0);
  expect(await readdir(join(paths.runtimeDir, 'active'))).toEqual([]);
  await expect(handler('notes_create')(args)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
});

it('prepared resolver refuses every href outside its verified grant map, including readable files', async () => {
  const secret = join(dir, 'not-an-attachment.png');
  await writeFile(secret, 'private bytes');
  const args = await hooked('codex', 'notes_create', { title: 'T', markdown: `![](${href})` });
  const images = await makeImagePreparer('codex', paths, now)('notes_create', args);
  try {
    expect(await images.resolve(href)).toContain('/snapshots/');
    await expect(images.resolve(secret)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
    await expect(images.resolve(`file://${secret}`)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
  } finally { await images.release(); }
});

it('text preparer does not consume supplied ticket and rejects any later image request', async () => {
  const args = await hooked('codex', 'notes_create', { title: 'T', markdown: `![](${href})` });
  const images = await makeImagePreparer('codex', paths, now)('notes_create', { ...args, markdown: 'text' });
  await expect(images.resolve(href)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
  await images.release();
  expect(await readdir(join(paths.runtimeDir, 'tickets'))).toEqual([`${args.attachment_ticket}.json`]);
  await tools().handler('notes_create')(args);
});
