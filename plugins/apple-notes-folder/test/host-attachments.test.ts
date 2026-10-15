import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as claude from '../src/hosts/claude.js';
import * as codex from '../src/hosts/codex.js';
import { readVerifiedAttachments } from '../src/hosts/attachments.js';
import type { AttachmentContext, Host } from '../src/hosts/types.js';

// Expectations use our original synthetic probe PNG, never a later localImage.path.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sha256 = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';
const expected = [{ href: `attachment:${sha256}`, aliases: [], bytes: png, sha256 }];
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/hosts/${name}.json`, import.meta.url), 'utf8'));
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'notes-host-attachments-')); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

async function materialize(host: Host) {
  const original = await fixture(host);
  const records = host === 'claude' ? (await fixture('claude-authfailed-transcript')).transcriptRecords
    : original.transcriptRecords.slice(0, original.transcriptRecords.findIndex((r: any, i: number) => i > 0 && r.type === 'session_meta'));
  const sessionId = original.userPromptSubmit[0]?.session_id ?? original.userPromptSubmit.session_id;
  const transcriptPath = join(dir, `${host}.jsonl`);
  const context = { host, sessionId, transcriptPath };
  await save(context, records);
  return { context, records, original };
}
async function save(context: Omit<AttachmentContext, 'callId'>, records: unknown[]) {
  await writeFile(context.transcriptPath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function imageRecord(host: Host, records: any[]) {
  return records.find(r => host === 'claude' ? r.type === 'user' && !r.isMeta : r.payload?.content?.some((c: any) => c.type === 'input_image'));
}
function contentOf(host: Host, record: any) { return host === 'claude' ? record.message.content : record.payload.content; }

describe.each(['claude', 'codex'] as const)('%s hook contexts and original user attachments', host => {
  const adapter = host === 'claude' ? claude : codex;

  it(host === 'claude' ? 'parses real submit and documented/synthetic tool envelopes with fixed host' : 'parses real hook fields and pins the host', async () => {
    const { context, original } = await materialize(host);
    const raw = original.userPromptSubmit[0] ?? original.userPromptSubmit;
    expect(adapter.parseSessionContext({ ...raw, host: 'untrusted', transcript_path: context.transcriptPath })).toEqual(context);
    expect(adapter.parseToolContext(raw)).toBeNull();
    const tool = { ...raw, hook_event_name: 'PreToolUse', tool_use_id: 'call-1', transcript_path: context.transcriptPath };
    expect(adapter.parseToolContext(tool)).toEqual({ ...context, callId: 'call-1' });
    expect(adapter.parseToolContext({ ...tool, hook_event_name: 'PostToolUse' })).toEqual({ ...context, callId: 'call-1' });
    expect(adapter.parseSessionContext(tool)).toBeNull();
  });

  it.each([null, [], {}, { session_id: ' ', transcript_path: '/t' }, { session_id: 's', transcript_path: '' }, { session_id: 's', transcript_path: 'relative' }, { session_id: 's', transcript_path: '/t\u0000' }])('rejects incomplete hook input %j', raw => {
    expect(adapter.parseToolContext(raw)).toBeNull();
    expect(adapter.parseSessionContext(raw)).toBeNull();
  });

  it('rejects unknown events and missing/blank call IDs', async () => {
    const { context } = await materialize(host);
    const raw = { session_id: context.sessionId, transcript_path: context.transcriptPath };
    expect(adapter.parseSessionContext({ ...raw, hook_event_name: 'SessionEnd' })).toBeNull();
    for (const tool_use_id of [undefined, '', ' ', 1]) {
      expect(adapter.parseToolContext({ ...raw, hook_event_name: 'PreToolUse', tool_use_id })).toBeNull();
    }
  });

  it('does not coerce a malformed hook event into a supported tool event', async () => {
    const { context } = await materialize(host);
    const raw = { session_id: context.sessionId, transcript_path: context.transcriptPath, tool_use_id: 'call-1' };
    expect(adapter.parseToolContext({ ...raw, hook_event_name: ['PreToolUse'] })).toBeNull();
  });

  it('reads observed preserved user bytes, including earlier messages in the same dialog', async () => {
    const { context, records } = await materialize(host);
    expect(await readVerifiedAttachments(context)).toEqual(expected);
    const previous = structuredClone(imageRecord(host, records));
    if (host === 'claude') { previous.uuid = 'later-text-message'; previous.message.content = [{ type: 'text', text: 'Use the earlier image' }]; }
    else {
      previous.payload.id = 'later-text-message';
      previous.payload.content = [{ type: 'input_text', text: 'Use the earlier image' }];
      previous.payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['user.text'];
      previous.metadata.retained_source.id.message_id = 'later-text-message';
    }
    await save(context, [...records, previous]);
    expect(await readVerifiedAttachments({ ...context, callId: 'later-call' } as AttachmentContext)).toEqual(expected);
    expect(await adapter.readAttachments(context)).toEqual(expected);
  });

  it('rejects a foreign session rather than authorizing its images', async () => {
    const { context } = await materialize(host);
    await expect(readVerifiedAttachments({ ...context, sessionId: 'another-session' })).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it('rejects malformed/truncated JSONL without leaking message or base64', async () => {
    const { context } = await materialize(host);
    await writeFile(context.transcriptPath, '{"private-user-text":"secret-incomplete');
    const error = await readVerifiedAttachments(context).catch(e => e);
    expect(error).toMatchObject({ code: 'IMAGE_PROVENANCE' });
    expect(error.message).not.toContain('secret-incomplete');
    expect(error.message).not.toContain(png.toString('base64'));
  });

  it('rejects missing transcripts and unknown transcript formats', async () => {
    const { context } = await materialize(host);
    await save(context, [{ type: 'unknown', images: [png.toString('base64')] }]);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
    await rm(context.transcriptPath);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it('does not turn assistant images, view_image, generated images or screenshots into grants', async () => {
    const { context, records } = await materialize(host);
    const record = imageRecord(host, records);
    const image = contentOf(host, record).find((c: any) => c.type === (host === 'claude' ? 'image' : 'input_image'));
    const toolResults = ['view_image', 'image_gen', 'screenshot'].map(name => host === 'claude'
      ? { type: 'user', sessionId: context.sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: name, content: [image] }] } }
      : { type: 'response_item', payload: { type: 'function_call_output', call_id: name, output: [image] } });
    const assistant = host === 'claude'
      ? { type: 'assistant', sessionId: context.sessionId, message: { role: 'assistant', content: [image] } }
      : { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [image] } };
    await save(context, [...records.filter((r: any) => r.type === 'session_meta'), ...toolResults, assistant]);
    expect(await readVerifiedAttachments(context)).toEqual([]);
  });

  it('does not promote text paths (including Cyrillic and spaces) to image aliases', async () => {
    const { context, records } = await materialize(host);
    const record = imageRecord(host, records);
    contentOf(host, record).push({ type: host === 'claude' ? 'text' : 'input_text', text: '<image name=[Image #1] path="/tmp/Мои фото/original.png">' });
    if (host === 'codex') record.payload.internal_chat_message_metadata_passthrough.content_item_kinds.push('user.text');
    await save(context, records);
    expect(await readVerifiedAttachments(context)).toEqual(expected);
  });

  it.each(['original', 'replaced', 'symlink'] as const)('rejects path-only localImage provenance even when source is %s', async state => {
    const { context, records } = await materialize(host);
    const source = join(dir, 'Мои фото original.png');
    if (state === 'symlink') { await writeFile(join(dir, 'target.png'), png); await symlink(join(dir, 'target.png'), source); }
    else await writeFile(source, state === 'replaced' ? Buffer.from('replacement') : png);
    const content = contentOf(host, imageRecord(host, records));
    content.splice(0, content.length, { type: 'localImage', path: source });
    await save(context, records);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it('keeps original host bytes when a mentioned local path is replaced or becomes a symlink', async () => {
    const { context, records } = await materialize(host);
    const source = join(dir, 'original.png');
    await writeFile(source, 'replacement');
    const record = imageRecord(host, records);
    contentOf(host, record).push({ type: host === 'claude' ? 'text' : 'input_text', text: source });
    if (host === 'codex') record.payload.internal_chat_message_metadata_passthrough.content_item_kinds.push('user.text');
    await save(context, records);
    expect(await readVerifiedAttachments(context)).toEqual(expected);
    await rm(source);
    await symlink('/missing', source);
    expect(await readVerifiedAttachments(context)).toEqual(expected);
  });

  it.each(['bad-base64', 'oversize', 'unknown-source', 'wrong-signature', 'mime-mismatch'] as const)('rejects inline image with %s', async bad => {
    const { context, records } = await materialize(host);
    const content = contentOf(host, imageRecord(host, records));
    const image = content.find((c: any) => c.type === (host === 'claude' ? 'image' : 'input_image'));
    let data = png.toString('base64');
    if (bad === 'bad-base64') data = '!not-base64!';
    if (bad === 'oversize') data = 'A'.repeat(4 * Math.ceil((10 * 1024 * 1024 + 1) / 3));
    if (bad === 'wrong-signature') data = Buffer.from('not an image').toString('base64');
    if (host === 'claude') image.source = bad === 'unknown-source' ? { type: 'url', url: 'https://example.invalid/image.png' }
      : { type: 'base64', media_type: bad === 'mime-mismatch' ? 'image/jpeg' : 'image/png', data };
    else image.image_url = bad === 'unknown-source' ? 'https://example.invalid/image.png' : `data:${bad === 'mime-mismatch' ? 'image/jpeg' : 'image/png'};base64,${data}`;
    await save(context, records);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it('accepts an image at the 10 MB boundary without recursive base64 validation', async () => {
    const { context, records } = await materialize(host);
    // PNG signature with trailing bytes exercises the documented signature/size policy.
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    png.copy(bytes);
    const item = contentOf(host, imageRecord(host, records)).find((c: any) => c.type === (host === 'claude' ? 'image' : 'input_image'));
    if (host === 'claude') item.source.data = bytes.toString('base64');
    else item.image_url = `data:image/png;base64,${bytes.toString('base64')}`;
    await save(context, records);
    const attachments = await readVerifiedAttachments(context);
    expect(attachments).toHaveLength(1);
    expect(Buffer.from(attachments[0].bytes).equals(bytes)).toBe(true);
  });
});

describe('host-specific binding and clearly labeled structural negatives', () => {
  it('retains the incomplete real Claude fixture as incomplete', async () => {
    const original = await fixture('claude');
    expect(claude.parseToolContext(original.preToolUse)).toBeNull();
    expect(original.transcriptRecords).toEqual([]);
  });

  it.each(['isMeta', 'turnCompanion', 'isSidechain'] as const)('Claude synthetic structural case: %s user images grant nothing', async flag => {
    const { context, records } = await materialize('claude');
    imageRecord('claude', records)[flag] = true;
    await save(context, records);
    expect(await readVerifiedAttachments(context)).toEqual([]);
  });

  it.each(['sessionId', 'message.role'] as const)('Claude synthetic structural case: missing %s cannot bind image', async field => {
    const { context, records } = await materialize('claude');
    const record = imageRecord('claude', records);
    if (field === 'sessionId') delete record.sessionId; else record.message.role = 'assistant';
    await save(context, records);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it.each(['message-id', 'turn-id', 'retained-role', 'image-kind'] as const)('Codex rejects mismatched retained identity: %s', async field => {
    const { context, records } = await materialize('codex');
    const record = imageRecord('codex', records);
    if (field === 'message-id') record.metadata.retained_source.id.message_id = 'other';
    if (field === 'turn-id') record.metadata.retained_source.id.turn_id = 'other';
    if (field === 'retained-role') record.metadata.retained_source.id.role = 'assistant';
    if (field === 'image-kind') record.payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['user.text'];
    await save(context, records);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it.each(['swapped-kinds', 'text-declared-image', 'extra-declaration', 'short-kinds', 'extra-image'] as const)(
    'Codex rejects contradictory per-item image provenance: %s', async mismatch => {
      const { context, records } = await materialize('codex');
      const record = imageRecord('codex', records);
      const content = record.payload.content;
      const kinds = record.payload.internal_chat_message_metadata_passthrough.content_item_kinds;
      if (mismatch === 'swapped-kinds') [kinds[0], kinds[1]] = [kinds[1], kinds[0]];
      if (mismatch === 'text-declared-image') kinds[2] = 'user.image';
      if (mismatch === 'extra-declaration') kinds.push('user.image');
      if (mismatch === 'short-kinds') kinds.pop();
      if (mismatch === 'extra-image') content.push(structuredClone(content[1]));
      await save(context, records);
      await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
    },
  );

  it('Codex accepts multiple image blocks only with corresponding per-item declarations', async () => {
    const { context, records } = await materialize('codex');
    const record = imageRecord('codex', records);
    record.payload.content.push(structuredClone(record.payload.content[1]));
    record.payload.internal_chat_message_metadata_passthrough.content_item_kinds.push('user.image');
    await save(context, records);
    expect(await readVerifiedAttachments(context)).toEqual(expected);
  });

  it('Codex rejects concatenated transcripts from another session', async () => {
    const { context, records } = await materialize('codex');
    await save(context, [...records, { type: 'session_meta', payload: { id: 'foreign-session' } }]);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it('Codex reads original bytes from the real post-preparation mutation session', async () => {
    const original = await fixture('codex');
    const index = original.transcriptRecords.findLastIndex((r: any) => r.type === 'session_meta');
    const records = original.transcriptRecords.slice(index);
    const context = { host: 'codex' as const, sessionId: records[0].payload.id, transcriptPath: join(dir, 'mutation.jsonl') };
    await save(context, records);
    expect(await readVerifiedAttachments(context)).toEqual(expected);
  });

  it('Codex reports the real image preparation failure as unavailable original bytes', async () => {
    const original = await fixture('codex');
    const indexes = original.transcriptRecords.flatMap((r: any, index: number) => r.type === 'session_meta' ? [index] : []);
    const records = original.transcriptRecords.slice(indexes[1], indexes[2]);
    const context = { host: 'codex' as const, sessionId: records[0].payload.id, transcriptPath: join(dir, 'unprepared.jsonl') };
    await save(context, records);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });

  it('Codex rejects missing inline bytes when retained kinds still declare an image', async () => {
    const { context, records } = await materialize('codex');
    const record = imageRecord('codex', records);
    record.payload.content = record.payload.content.filter((c: any) => c.type !== 'input_image');
    await save(context, records);
    await expect(readVerifiedAttachments(context)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
  });
});
