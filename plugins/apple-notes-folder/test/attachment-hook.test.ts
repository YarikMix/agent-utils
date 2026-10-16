import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../src/hook.js';
import { consumeTicket } from '../src/attachments/tickets.js';
import * as attachments from '../src/hosts/attachments.js';
import type { Host, RuntimePaths, WriteToolName } from '../src/hosts/types.js';

const hash = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';
const href = `attachment:${hash}`;
const now = () => 1792104000000;
const prefixes = { codex: 'mcp__apple_notes_folder__', claude: 'mcp__plugin_apple-notes-folder_apple-notes-folder__' };
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/hosts/${name}.json`, import.meta.url), 'utf8'));
let dir: string;
let paths: RuntimePaths;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'notes-attachment-hook-'))); paths = { configFile: null, runtimeDir: join(dir, 'runtime') }; });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

async function materialize(host: Host) {
  const original = await fixture(host);
  // Real persisted user bytes; Claude tool envelope below is explicitly synthetic/documented.
  const records = host === 'claude' ? (await fixture('claude-authfailed-transcript')).transcriptRecords
    : original.transcriptRecords.slice(original.transcriptRecords.findLastIndex((r: any) => r.type === 'session_meta'));
  const sessionId = host === 'claude' ? original.userPromptSubmit.session_id : records[0].payload.id;
  const transcriptPath = join(dir, `${host}.jsonl`);
  await writeFile(transcriptPath, records.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n');
  const raw = host === 'claude' ? original.userPromptSubmit : original.preToolUse.at(-1);
  const call = { ...raw, session_id: sessionId, transcript_path: transcriptPath, hook_event_name: 'PreToolUse', tool_use_id: 'own-write-call', tool_name: `${prefixes[host]}notes_create`, tool_input: { title: 'Image', markdown: `![](${href})` } };
  return { call, records, transcriptPath };
}
const output = async (host: Host, call: unknown) => JSON.parse(await runHook(host, JSON.stringify(call), paths, now)).hookSpecificOutput;

describe.each(['codex', 'claude'] as const)('%s attachment hooks (Claude tool envelopes synthetic/documented)', host => {
  it.each(['notes_create', 'notes_append', 'notes_update'] as const)('issues a real consumable grant for %s without changing Markdown or args', async (name: WriteToolName) => {
    const { call } = await materialize(host);
    call.tool_name = `${prefixes[host]}${name}`;
    const result = await output(host, call);
    expect(result).toMatchObject({ hookEventName: 'PreToolUse', updatedInput: call.tool_input });
    if (host === 'claude') expect(result).not.toHaveProperty('permissionDecision');
    else expect(result.permissionDecision).toBe('allow'); // Codex rewrite gate; client approval is separate.
    expect(result.updatedInput.attachment_ticket).toMatch(/^[a-f0-9]{64}$/);
    const manifest = JSON.parse(await readFile(join(paths.runtimeDir, 'tickets', `${result.updatedInput.attachment_ticket}.json`), 'utf8'));
    expect(manifest).toMatchObject({ host, sessionId: call.session_id, callId: call.tool_use_id, tool: name });
    expect((await stat(paths.runtimeDir)).mode & 0o777).toBe(0o700);
    const lease = await consumeTicket(paths, host, name, result.updatedInput, now);
    expect(lease.images).toHaveLength(1);
    expect(lease.images[0]).toMatchObject({ href, sha256: hash });
    expect((await readFile(lease.images[0].snapshotPath)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await lease.release();
  });

  it('distinguishes a retained ambiguous lock from provenance denial without exposing private data', async () => {
    const { call } = await materialize(host);
    await mkdir(join(paths.runtimeDir, '.lock'), { recursive: true, mode: 0o700 });
    const result = await output(host, call);
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toContain('lock');
    expect(result.permissionDecisionReason).toContain('README');
    expect(result.updatedInput).toBeUndefined();
    expect(result.permissionDecisionReason).not.toContain(dir);
    expect(result.permissionDecisionReason).not.toContain(href);
    expect((await stat(join(paths.runtimeDir, '.lock'))).isDirectory()).toBe(true);
    call.tool_input.markdown = 'text remains usable';
    expect(await runHook(host, JSON.stringify(call), paths, now)).toBe('');
  });

  it('uses converter hrefs for reference images nested inside emphasis and blockquotes', async () => {
    const { call } = await materialize(host);
    call.tool_input.markdown = `> **![image][photo]**\n\n[photo]: ${href}`;
    const result = await output(host, call);
    const lease = await consumeTicket(paths, host, 'notes_create', result.updatedInput, now);
    expect(lease.images.map(i => i.href)).toEqual([href]);
    expect(result.updatedInput.markdown).toBe(call.tool_input.markdown);
    await lease.release();
  });

  it('text calls return empty without reading a transcript, even with a supplied ticket', async () => {
    const { call } = await materialize(host);
    const reads = vi.spyOn(attachments, 'readVerifiedAttachments');
    call.tool_input = { title: 'Text', markdown: 'plain **text**, `![code](file:///tmp/private.png)`', attachment_ticket: 'f'.repeat(64) } as any;
    await rm(call.transcript_path);
    expect(await runHook(host, JSON.stringify(call), paths, now)).toBe('');
    expect(reads).toHaveBeenCalledTimes(0);
    await expect(stat(paths.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces a model-supplied ticket only after original bytes were verified', async () => {
    const { call } = await materialize(host);
    (call.tool_input as any).attachment_ticket = 'f'.repeat(64);
    const result = await output(host, call);
    expect(result.updatedInput.attachment_ticket).not.toBe('f'.repeat(64));
    await rm(call.transcript_path);
    expect(await output(host, { ...call, tool_input: result.updatedInput })).toMatchObject({ permissionDecision: 'deny' });
  });

  it('denies an unsupported transcript without returning rewritten input or leaking content', async () => {
    const { call } = await materialize(host);
    await writeFile(call.transcript_path, JSON.stringify({ secret: 'PRIVATE_USER_TEXT', bytes: 'PRIVATE_IMAGE_BYTES' }) + '\n');
    const result = await output(host, call);
    expect(result).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(result.updatedInput).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_USER_TEXT|PRIVATE_IMAGE_BYTES/);
    await expect(stat(paths.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['session_id', 'tool_use_id', 'transcript_path'])('denies images with missing %s', async field => {
    const { call } = await materialize(host);
    delete (call as any)[field];
    expect(await output(host, call)).toMatchObject({ permissionDecision: 'deny' });
  });

  it('rejects arbitrary filesystem paths and gives only safe available hrefs for retry', async () => {
    const { call } = await materialize(host);
    call.tool_input.markdown = '![](/tmp/PRIVATE_USER_PATH.png)';
    const result = await output(host, call);
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toContain(href);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_USER_PATH');
    expect(result.updatedInput).toBeUndefined();
    await expect(stat(paths.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['mcp__foreign__notes_create', 'mcp__foreign__apple_notes_folder__notes_create', 'notes_create', 'mcp__plugin_attachment-contract-probe_apple-notes-folder__notes_create'])('ignores foreign or probe namespace %s', async tool_name => {
    const { call } = await materialize(host);
    const reads = vi.spyOn(attachments, 'readVerifiedAttachments');
    expect(await runHook(host, JSON.stringify({ ...call, tool_name }), paths, now)).toBe('');
    expect(reads).toHaveBeenCalledTimes(0);
  });

  it.each(['PostToolUse', 'SessionEnd', 'Unknown'])('does not issue a ticket for %s', async hook_event_name => {
    const { call } = await materialize(host);
    const reads = vi.spyOn(attachments, 'readVerifiedAttachments');
    expect(await runHook(host, JSON.stringify({ ...call, hook_event_name }), paths, now)).toBe('');
    expect(reads).toHaveBeenCalledTimes(0);
  });

  it('prompt context exposes only canonical safe hrefs, never message text, paths, bytes, or a ticket', async () => {
    const { call } = await materialize(host);
    const result = await output(host, { ...call, hook_event_name: 'UserPromptSubmit' });
    expect(result.hookEventName).toBe('UserPromptSubmit');
    expect(result.additionalContext).toContain(href);
    expect(result.additionalContext).not.toMatch(/base64|iVBOR|\/synthetic\/|probe_attachment|attachment_ticket/);
    await expect(stat(paths.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unavailable prompt context fails closed without affecting subsequent shell checks', async () => {
    const { call } = await materialize(host);
    await rm(call.transcript_path);
    expect(await runHook(host, JSON.stringify({ ...call, hook_event_name: 'UserPromptSubmit' }), paths, now)).toBe('');
    expect(await output(host, { ...call, tool_name: 'Bash', tool_input: { command: 'osascript -e \'tell application "Notes" to count notes\'' } })).toMatchObject({ permissionDecision: 'deny' });
  });
});

it('Codex prompt before image preparation may be empty; PreToolUse supplies safe hrefs for a retry', async () => {
  const original = await fixture('codex');
  const event = original.events.find((e: any) => e.kind === 'hook' && e.payload.hook_event_name === 'UserPromptSubmit' && e.records?.length);
  expect(event).toBeDefined();
  const { call } = await materialize('codex');
  await writeFile(call.transcript_path, event.records.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n');
  expect(await runHook('codex', JSON.stringify({ ...event.payload, transcript_path: call.transcript_path }), paths, now)).toBe('');
  const prepared = await materialize('codex');
  prepared.call.tool_input.markdown = '![](/synthetic/probe/codex/image.png)';
  expect((await output('codex', prepared.call)).permissionDecisionReason).toContain(href);
});
