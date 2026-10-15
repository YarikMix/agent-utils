import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, hook, report, verify, consumeMarker, PNG } from './probe-host.mjs';

// Helper tests only: these records are NEVER presented as observed host fixtures.
test('prepare isolates hosts, emits JSONL, verifier refuses missing evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attachment-probe-test-'));
  for (const host of ['claude', 'codex']) {
    const { out, plugin } = await prepare(host, root);
    assert.equal((await stat(out)).mode & 0o777, 0o700);
    assert.equal((await stat(join(out, 'image.png'))).mode & 0o777, 0o600);
    const input = await readFile(join(out, 'claude-input.json'), 'utf8');
    assert.equal(input.trim().split('\n').length, 1);
    assert.equal(JSON.parse(input).message.content[0].source.data, PNG);
    const claude = JSON.parse(await readFile(join(plugin, '.claude-plugin/plugin.json')));
    const codex = JSON.parse(await readFile(join(plugin, '.codex-plugin/plugin.json')));
    assert.equal(claude.hooks, './hooks/claude.json');
    assert.equal(codex.hooks, './hooks/codex.json');
    assert.equal(codex.mcpServers, './.mcp.json');
    const rootMcp = JSON.parse(await readFile(join(plugin, '.mcp.json')));
    assert.deepEqual(Object.keys(claude.mcpServers), ['apple-notes-folder']);
    assert.deepEqual(Object.keys(rootMcp.mcpServers), ['apple-notes-folder']);
    await assert.rejects(prepare(host, root), /EEXIST/);
  }
  const result = await verify(root);
  assert.equal(result.reports.length, 2);
  assert.ok(result.failures.includes('codex: codeModeBlocked=false'));
  assert.ok(result.failures.includes('claude: rewriteReceived=false'));
});
test('model-supplied ticket and late localImage path cannot pass host contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attachment-probe-test-'));
  const { out } = await prepare('codex', root);
  await appendFile(join(out, 'events.jsonl'), JSON.stringify({ kind: 'server-call', host: 'codex', args: { marker: 'after', markdown: 'baseline', attachment_ticket: 'probe-v1' } }) + '\n');
  assert.equal((await report(out)).rewriteReceived, false);
  assert.equal((await report(out)).originalBytes, false);
  const output = await hook(out, 'codex', { hook_event_name: 'UserPromptSubmit', session_id: 'helper-only', prompt: 'synthetic', input: [{ type: 'localImage', path: join(out, 'image.png') }] });
  assert.match(output.hookSpecificOutput.additionalContext, /probe-attachment:\/\//);
  assert.equal((await report(out)).originalBytes, false);
});
test('rewrite is controlled and guard denies only its exact synthetic command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attachment-probe-test-'));
  const { out } = await prepare('claude', root);
  const event = { hook_event_name: 'PreToolUse', tool_name: 'mcp__probe__probe_attachment', tool_input: { marker: 'after', markdown: 'body' } };
  assert.deepEqual(await hook(out, 'claude', event), {});
  await writeFile(join(out, 'controls.json'), JSON.stringify({ rewrite: true }));
  const output = await hook(out, 'claude', event);
  assert.equal(output.hookSpecificOutput.updatedInput.attachment_ticket, 'probe-v1');
  assert.equal(output.hookSpecificOutput.updatedInput.markdown, 'body');
  const config = JSON.parse(await readFile(join(out, 'run.json')));
  const denied = await hook(out, 'claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: config.guardCommand } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hook(out, 'claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo APPLE_NOTES_PROBE_GUARD' } }), {});
});
test('assistant images and a test-side image copy do not count as original user bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attachment-probe-test-'));
  const { out } = await prepare('claude', root);
  const transcript = join(out, 'helper-transcript.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', data: PNG } }] } }) + '\n');
  await hook(out, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'helper-only', transcript_path: transcript });
  assert.equal((await report(out)).originalBytes, false);
  const records = (await readFile(join(out, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.at(-1).unboundImageHashes, []);
});

async function syntheticRun(client = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'attachment-probe-review-'));
  const { out } = await prepare(client, root);
  const config = JSON.parse(await readFile(join(out, 'run.json')));
  const record = async (...entries) => appendFile(join(out, 'events.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { out, config, record };
}
for (const [serverSession, serverCall] of [['foreign-session', 'foreign-call'], ['rewrite-session', 'different-call']]) {
  test(`I2: ignored rewrite plus independent ticket cannot pass (${serverSession}/${serverCall})`, async () => {
    const { out, record } = await syntheticRun();
    await record(
      { kind: 'hook', host: 'claude', at: 1, payload: { hook_event_name: 'PreToolUse', session_id: 'rewrite-session', tool_use_id: 'rewrite-call', tool_name: 'mcp__probe__probe_attachment', tool_input: { marker: 'after', markdown: 'same-body' } }, records: [], output: { hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { marker: 'after', markdown: 'same-body', attachment_ticket: 'probe-v1' } } } },
      { kind: 'server-call', host: 'claude', at: 2, session_id: serverSession, tool_use_id: serverCall, requestId: 'independent-request', args: { marker: 'after', markdown: 'same-body', attachment_ticket: 'probe-v1' } },
    );
    assert.equal((await report(out)).rewriteReceived, false);
  });
}
test('I3: old submit bytes do not prove the mutation submit attachment', async () => {
  const { out, config, record } = await syntheticRun();
  await record(
    { kind: 'hook', host: 'claude', at: 1, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'same-session', prompt_id: 'old-prompt' }, records: [], imageHashes: [config.pngSha256], output: {} },
    { kind: 'mutation', host: 'claude', at: 2, session: 'same-session', prompt_id: 'mutation-prompt', originalInlineBytes: false, replacementSha256: 'replacement' },
    { kind: 'hook', host: 'claude', at: 3, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'same-session', prompt_id: 'mutation-prompt' }, records: [], imageHashes: [], output: {} },
  );
  assert.equal((await report(out)).originalBytes, false);
});
test('I3: inline image from another transcript session cannot prove mutation bytes', async () => {
  const { out } = await syntheticRun();
  const transcript = join(out, 'foreign-user-record.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'foreign-session', uuid: 'foreign-message', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: PNG } }] } }) + '\n');
  await writeFile(join(out, 'controls.json'), JSON.stringify({ mutateOnSubmit: true }));
  await hook(out, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'mutation-session', prompt_id: 'mutation-prompt', transcript_path: transcript });
  assert.equal((await report(out)).originalBytes, false);
});
test('I4: ordinary shell deny with historical Code Mode text cannot prove Code Mode guard', async () => {
  const { out, config, record } = await syntheticRun('codex');
  await record({ kind: 'hook', host: 'codex', at: 10, payload: { hook_event_name: 'PreToolUse', session_id: 'current-session', tool_use_id: 'ordinary-shell-now', tool_name: 'Bash', tool_input: { command: config.codeGuardCommand } }, records: [
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec', call_id: 'old-outer-call', arguments: 'await tools.exec_command({cmd:"echo APPLE_NOTES_PROBE_GUARD_CODE"})' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'old-outer-call', output: 'historical success' } },
  ], imageHashes: [], output: { hookSpecificOutput: { permissionDecision: 'deny' } } });
  assert.equal((await report(out)).codeModeBlocked, false);
});
test('diagnostic rewrite markers are unique, host-bound, one-use and never establish a host contract', async () => {
  const { out } = await syntheticRun();
  await writeFile(join(out, 'controls.json'), JSON.stringify({ rewrite: true }));
  const payload = { hook_event_name: 'PreToolUse', session_id: 'helper-only', tool_use_id: 'unobserved-format', tool_name: 'mcp__probe__probe_attachment', tool_input: { marker: 'after', markdown: 'body' } };
  const first = (await hook(out, 'claude', payload)).hookSpecificOutput.updatedInput;
  const second = (await hook(out, 'claude', payload)).hookSpecificOutput.updatedInput;
  assert.notEqual(first.marker, second.marker);
  assert.match(first.marker, /^probe-after-/);
  assert.equal((await consumeMarker(out, 'codex', first.marker, 'foreign-request')).reason, 'foreign-host');
  const receipt = await consumeMarker(out, 'claude', first.marker, 'first-request');
  assert.equal(receipt.accepted, true);
  assert.ok(receipt.hookEventId && receipt.serverReceiptId);
  assert.equal((await consumeMarker(out, 'claude', first.marker, 'replay-request')).reason, 'marker-already-used');
  const result = await report(out);
  assert.equal(result.rewriteReceived, false);
  assert.match(result.unverified.rewriteReceived, /exact.*identity adapter/);
});
test('mutation diagnostics name exactly the local submit event without asserting attachment identity', async () => {
  const { out } = await syntheticRun();
  await writeFile(join(out, 'controls.json'), JSON.stringify({ mutateOnSubmit: true }));
  await hook(out, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'helper-session', prompt_id: 'helper-prompt' });
  const entries = (await readFile(join(out, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const mutation = entries.find((e) => e.kind === 'mutation');
  const submit = entries.find((e) => e.kind === 'hook');
  assert.equal(mutation.submitEventId, submit.eventId);
  assert.equal(mutation.promptId, 'helper-prompt');
  assert.equal(mutation.attachmentBindingVerified, false);
  const result = await report(out);
  assert.equal(result.originalBytes, false);
  assert.match(result.unverified.originalBytes, /submit\/message\/attachment identity/);
});
