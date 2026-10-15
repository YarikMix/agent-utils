import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, hook, report, verify, PNG } from './probe-host.mjs';

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
  assert.deepEqual(records.at(-1).imageHashes, []);
});
