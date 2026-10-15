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
test('guard reason echoes observed Codex session/turn/tool-use ids for outer result correlation', async () => {
  const { out, config } = await syntheticRun('codex');
  const payload = { hook_event_name: 'PreToolUse', session_id: 'synthetic-session', turn_id: 'synthetic-turn', tool_use_id: 'synthetic-tool-call', tool_name: 'Bash', tool_input: { command: config.codeGuardCommand } };
  const result = await hook(out, 'codex', payload);
  assert.equal(result.hookSpecificOutput.permissionDecisionReason, 'Synthetic probe guard marker [session=synthetic-session turn=synthetic-turn call=synthetic-tool-call]');
});
test('prepared-image mutation binds the observed current user message and rereads host bytes', async () => {
  const { out } = await syntheticRun('codex');
  const transcript = join(out, 'prepared-user.jsonl');
  const records = [{ type: 'session_meta', payload: { id: 'observed-shape-session' } }, { type: 'response_item', payload: { type: 'message', id: 'observed-shape-message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }], internal_chat_message_metadata_passthrough: { turn_id: 'observed-shape-turn', content_item_kinds: ['user.image'] } }, metadata: { retained_source: { id: { message_id: 'observed-shape-message', turn_id: 'observed-shape-turn', role: 'user' } } } }];
  await writeFile(transcript, records.map(JSON.stringify).join('\n')+'\n');
  await writeFile(join(out, 'controls.json'), JSON.stringify({ mutateBeforeTool: true }));
  await hook(out, 'codex', { hook_event_name: 'PreToolUse', session_id: 'observed-shape-session', turn_id: 'observed-shape-turn', tool_use_id: 'observed-shape-call', transcript_path: transcript, tool_name: 'mcp__apple_notes_folder__probe_attachment', tool_input: { marker: 'after', markdown: 'test' } });
  const entries=(await readFile(join(out,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const mutation=entries.find(e=>e.kind==='mutation' && e.phase==='image-prepared-before-tool');
  assert.equal(mutation?.imageMessageId,'observed-shape-message');
  assert.equal(mutation?.toolUseId,'observed-shape-call');
  assert.notDeepEqual(await readFile(join(out,'image.png')),Buffer.from(PNG,'base64'));
});

async function observedCodexReplay(mutate = () => {}) {
  const {out} = await syntheticRun('codex');
  const fixture = JSON.parse(await readFile(new URL('../test/fixtures/hosts/codex.json',import.meta.url),'utf8'));
  const mapped = JSON.parse(JSON.stringify(fixture).replaceAll('/synthetic/probe/codex',out).replaceAll('/synthetic/codex/',out+'/'));
  mutate(mapped);
  await writeFile(join(out,'run.json'),JSON.stringify(mapped.run));
  await appendFile(join(out,'events.jsonl'),mapped.events.map(JSON.stringify).join('\n')+'\n');
  let session, records=[];
  const saveSession=async()=>{if(session)await writeFile(join(out,`transcript-${session}.jsonl`),records.map(JSON.stringify).join('\n')+'\n');};
  for(const record of mapped.transcriptRecords) {
    if(record.type==='session_meta'){await saveSession();session=record.payload.id;records=[];}
    records.push(record);
  }
  await saveSession();
  return {out,fixture:mapped};
}
test('observed Codex 0.162.1 fixture proves exact-call rewrite, prepared image and both guard paths', async()=>{
  const {out,fixture}=await observedCodexReplay();
  const actual=await report(out);
  for(const [key,value] of Object.entries(fixture.expected))assert.equal(actual[key],value,key);
});
for (const [name, mutate, rejected] of [
  ['foreign PostToolUse call ids', f=>{for(const e of f.events)if(e.payload?.hook_event_name==='PostToolUse')e.payload.tool_use_id+='-foreign';}, 'rewriteReceived'],
  ['replayed one-use server markers', f=>{f.events.push(...f.events.filter(e=>e.kind==='server-call'&&e.args.marker.startsWith('probe-after-')).map(e=>structuredClone(e)));}, 'rewriteReceived'],
  ['mutation from a different session', f=>{for(const e of f.events)if(e.phase==='image-prepared-before-tool')e.session='foreign-session';}, 'originalBytes'],
  ['mutation image message from another turn', f=>{for(const e of f.events)if(e.phase==='image-prepared-before-tool')e.imageMessageId='old-message';}, 'originalBytes'],
  ['only the early UPS mutation', f=>{f.events=f.events.filter(e=>e.phase!=='image-prepared-before-tool');}, 'originalBytes'],
  ['Code Mode result from another outer call', f=>{for(const r of f.transcriptRecords)if(r.payload?.type==='custom_tool_call_output')r.payload.call_id+='-foreign';}, 'codeModeBlocked'],
  ['nested deny id differs from echoed Code Mode result', f=>{for(const e of f.events)if(e.payload?.tool_input?.command===f.run.codeGuardCommand)e.payload.tool_use_id+='-foreign';}, 'codeModeBlocked'],
  ['mixed client versions', f=>{f.events.find(e=>e.clientInfo).clientInfo.version='0.162.2';}, 'rewriteReceived'],
  ['unknown client version', f=>{for(const e of f.events)if(e.clientInfo)e.clientInfo.version='0.162.2';}, 'rewriteReceived'],
]) {
  test(`observed-fixture tamper rejects ${name}`,async()=>{
    const {out}=await observedCodexReplay(mutate);
    assert.equal((await report(out))[rejected],false);
  });
}
test('prepare emits session-only source routing and an image/prompt separator',async()=>{
  const {out}=await syntheticRun('codex');
  const command=await readFile(join(out,'codex-command.txt'),'utf8');
  assert.match(command,/marketplaces\.attachment-probe-local\.source_type/);
  assert.match(command,/marketplaces\.attachment-probe-local\.source=/);
  assert.ok(command.includes("'--image' ")&&command.includes(" '--' "));
});
