#!/usr/bin/env node
/** Development-only host-contract probe. Never connects to Apple Notes. */
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const self = fileURLToPath(import.meta.url);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const privateFile = async (path, value) => writeFile(path, value, { mode: 0o600, flag: 'wx' });
const save = (path, value) => privateFile(path, JSON.stringify(value, null, 2) + '\n');
async function log(out, event) {
  await appendFile(join(out, 'events.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 });
}
async function events(out) {
  try { return (await readFile(join(out, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

export async function prepare(client, root) {
  if (!['claude', 'codex'].includes(client)) throw new Error('--client must be claude or codex');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await stat(root)).mode & 0o077) throw new Error('--out must be a private directory (0700)');
  const out = join(root, client);
  await mkdir(out, { mode: 0o700 }); // Refuse reuse: one private run per host.
  const plugin = join(out, 'plugins', 'attachment-contract-probe');
  for (const dir of [join(out, 'plugins'), plugin, join(plugin, '.claude-plugin'), join(plugin, '.codex-plugin'), join(plugin, 'hooks'), join(out, 'markers'), join(out, '.agents'), join(out, '.agents/plugins'), join(out, '.codex')]) {
    await mkdir(dir, { mode: 0o700 });
  }
  const config = { client, guardCommand: `: APPLE_NOTES_PROBE_GUARD; touch ${quote(join(out, 'guard-effect'))}`, codeGuardCommand: `: APPLE_NOTES_PROBE_GUARD_CODE; touch ${quote(join(out, 'code-guard-effect'))}`, nonce: randomUUID(), href: `probe-attachment://${randomUUID()}/image.png`, pngSha256: sha(Buffer.from(PNG, 'base64')) };
  await save(join(out, 'run.json'), config);
  await save(join(out, 'controls.json'), { rewrite: false, mutateOnSubmit: false, mutateBeforeTool: false });
  await privateFile(join(out, 'image.png'), Buffer.from(PNG, 'base64'));
  const command = (host, mode) => [process.execPath, self, mode, '--out', out, '--host', host].map(quote).join(' ');
  const hooks = (host) => ({ hooks: Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].map((name) => [name, [{ ...(name === 'UserPromptSubmit' ? {} : { matcher: '.*' }), hooks: [{ type: 'command', command: command(host, 'hook') }] }]])) });
  for (const host of ['claude', 'codex']) await save(join(plugin, `hooks/${host}.json`), hooks(host));
  const mcp = (host) => ({ command: process.execPath, args: [self, 'server', '--out', out, '--host', host] });
  const identity = { name: 'attachment-contract-probe', version: '1.0.0', description: 'Synthetic attachment contract probe; no Notes access' };
  await save(join(plugin, '.claude-plugin/plugin.json'), { ...identity, hooks: './hooks/claude.json', mcpServers: { 'apple-notes-folder': mcp('claude') } });
  await save(join(plugin, '.codex-plugin/plugin.json'), { ...identity, hooks: './hooks/codex.json', mcpServers: './.mcp.json' });
  await save(join(plugin, '.mcp.json'), { mcpServers: { 'apple-notes-folder': mcp('codex') } });
  await save(join(out, '.agents/plugins/marketplace.json'), { name: 'attachment-probe-local', plugins: [{ name: identity.name, source: { source: 'local', path: './plugins/attachment-contract-probe' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
  await privateFile(join(out, '.codex/config.toml'), '[plugins."attachment-contract-probe@attachment-probe-local"]\nenabled = true\n');
  const prompt = 'This is an authorized synthetic client-contract test. Call probe_attachment once with marker "before" and markdown "baseline". Do not include attachment_ticket. Do not use other tools or read files. Follow only probe hook instructions for attachment hrefs.';
  await privateFile(join(out, 'claude-input.json'), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: prompt }] } }) + '\n');
  await privateFile(join(out, 'prompt.txt'), prompt + '\n');
  const codexArgs = ['codex', '--no-daemon', '--no-alt-screen', '-c', 'marketplaces.attachment-probe-local.source_type="local"', '-c', `marketplaces.attachment-probe-local.source=${JSON.stringify(out)}`, '--cd', out, '--image', join(out, 'image.png'), '--', prompt];
  await privateFile(join(out, 'codex-command.txt'), codexArgs.map(quote).join(' ') + '\n');
  await privateFile(join(out, 'guard-command.txt'), config.guardCommand + '\n');
  await privateFile(join(out, 'code-guard-command.txt'), config.codeGuardCommand + '\n');
  await log(out, { kind: 'prepared', client, pngSha256: config.pngSha256 });
  return { out, plugin, prompt: join(out, 'prompt.txt'), image: join(out, 'image.png'), codexCommand: join(out, 'codex-command.txt') };
}

// Recursively find preserved host bytes. A local path alone is deliberately insufficient.
function inlineImages(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (value.type === 'image' && value.source?.type === 'base64') found.push(Buffer.from(value.source.data, 'base64'));
  if (value.type === 'input_image' && typeof value.image_url === 'string' && value.image_url.startsWith('data:image/')) found.push(Buffer.from(value.image_url.split(',')[1], 'base64'));
  for (const v of Object.values(value)) if (v && typeof v === 'object') inlineImages(v, found);
  return found;
}
function userImages(records) {
  return records.flatMap((r) => {
    if (r.type === 'user' && r.message?.role === 'user') return inlineImages(r.message.content);
    if (r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user') return inlineImages(r.payload.content);
    return [];
  });
}
// Observed Codex 0.162.1 retained user-message identity; never use an older turn.
function codexAttachment(records, payload) {
  if (!payload.session_id || !payload.turn_id || !records.some((r) => r.type === 'session_meta' && r.payload?.id === payload.session_id)) return null;
  const matches = records.filter((r) => {
    const p = r.payload, source = r.metadata?.retained_source?.id;
    return r.type === 'response_item' && p?.type === 'message' && p.role === 'user' &&
      p.internal_chat_message_metadata_passthrough?.turn_id === payload.turn_id &&
      p.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.image') &&
      source?.turn_id === payload.turn_id && source.message_id === p.id && source.role === 'user' &&
      p.content?.filter((c) => c.type === 'input_image').length === 1;
  });
  return matches.length === 1 ? matches[0] : null;
}
async function transcript(payload) {
  if (typeof payload.transcript_path !== 'string') return [];
  // Called only in our fresh synthetic probe session, never search other sessions.
  const info = await stat(payload.transcript_path);
  if (info.size > 10 * 1024 * 1024) throw new Error('Probe transcript exceeds 10 MiB');
  return (await readFile(payload.transcript_path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
export async function hook(out, host, payload) {
  const config = await json(join(out, 'run.json'));
  const eventId = randomUUID(); // Helper identity, never presented as a host call/message id.
  const controls = await json(join(out, 'controls.json'));
  let records = [], transcriptError;
  try { records = await transcript(payload); } catch (e) { transcriptError = e.code ?? e.message; }
  const imageHashes = userImages(records).map(sha);
  const event = payload.hook_event_name;
  const input = payload.tool_input ?? {};
  let output = {};
  if (event === 'UserPromptSubmit') {
    output = { hookSpecificOutput: { hookEventName: event, additionalContext: `For the synthetic probe, markdown MUST include ![](${config.href}). Never supply attachment_ticket yourself.` } };
    // Mutation is after the host accepted the user message, not a test-side pre-copy.
    if (controls.mutateOnSubmit) {
      await writeFile(join(out, 'image.png'), Buffer.from('synthetic replacement; deliberately no longer PNG'), { mode: 0o600 });
      await log(out, { kind: 'mutation', host, submitEventId: eventId, session: payload.session_id, promptId: payload.prompt_id ?? null, attachmentBindingVerified: false, unboundImageHashes: imageHashes, replacementSha256: sha(await readFile(join(out, 'image.png'))) });
    }
  }
  if (event === 'PreToolUse' && host === 'codex' && payload.tool_name === 'mcp__apple_notes_folder__probe_attachment' && input.marker === 'after' && controls.mutateBeforeTool) {
    const beforeImageRecord = codexAttachment(records, payload);
    if (beforeImageRecord && inlineImages(beforeImageRecord.payload.content).map(sha).includes(config.pngSha256)) {
      const sourceBeforeSha256 = sha(await readFile(join(out, 'image.png')));
      await writeFile(join(out, 'image.png'), Buffer.from('synthetic replacement after host image preparation'), { mode: 0o600 });
      records = await transcript(payload); // Reread host payload AFTER replacing our own source.
      const afterImageRecord = codexAttachment(records, payload);
      await log(out, { kind: 'mutation', phase: 'image-prepared-before-tool', host, preToolEventId: eventId,
        session: payload.session_id, turnId: payload.turn_id, toolUseId: payload.tool_use_id,
        imageMessageId: beforeImageRecord.payload.id, beforeImageRecord, afterImageRecord,
        sourceBeforeSha256, replacementSha256: sha(await readFile(join(out, 'image.png'))) });
    } else await log(out, { kind: 'mutation-refused', preToolEventId: eventId, reason: 'No unique current-turn retained user image with original bytes' });
  }
  if (event === 'PreToolUse' && /probe_attachment$/.test(payload.tool_name ?? '') && controls.rewrite && input.marker === 'after' && !input.attachment_ticket) {
    const marker = `probe-after-${randomUUID()}`;
    await save(join(out, 'markers', `${marker}.json`), { eventId, host, originalInput: input, rawHookPayload: payload });
    output = { hookSpecificOutput: { hookEventName: event, permissionDecision: 'allow', updatedInput: { ...input, marker, attachment_ticket: 'probe-v1' } } };
  }
  if (event === 'PreToolUse' && payload.tool_name === 'Bash' && [config.guardCommand, config.codeGuardCommand].includes(input.command)) {
    output = { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: `Synthetic probe guard marker [session=${payload.session_id ?? 'unobserved'} turn=${payload.turn_id ?? 'unobserved'} call=${payload.tool_use_id ?? 'unobserved'}]` } };
  }
  await log(out, { kind: 'hook', eventId, host, payload, records, transcriptError, unboundImageHashes: imageHashes, output });
  return output;
}

// Diagnostic only: one server request may consume a helper-issued marker once.
// This receipt does NOT prove that the same host call received updatedInput.
export async function consumeMarker(out, host, marker, requestId) {
  if (!/^probe-after-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(marker)) return null;
  try {
    const issued = await json(join(out, 'markers', `${marker}.json`));
    if (issued.host !== host) return { accepted: false, reason: 'foreign-host' };
    const receipt = { accepted: true, marker, hookEventId: issued.eventId, serverReceiptId: randomUUID(), requestId };
    await save(join(out, 'markers', `${marker}.consumed.json`), receipt);
    return receipt;
  } catch (e) {
    if (e.code === 'EEXIST') return { accepted: false, reason: 'marker-already-used' };
    if (e.code === 'ENOENT') return { accepted: false, reason: 'marker-not-issued' };
    throw e;
  }
}

async function server(out, host) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const config = await json(join(out, 'run.json'));
  const mcp = new McpServer({ name: `probe-${host}`, version: '1.0.0' });
  mcp.registerTool('probe_attachment', { description: 'Record synthetic marker and markdown; no filesystem or Notes operation', inputSchema: { marker: z.string(), markdown: z.string(), attachment_ticket: z.string().optional() } }, async (args, extra) => {
    const diagnosticReceipt = await consumeMarker(out, host, args.marker, extra.requestId);
    await log(out, { kind: 'server-call', host, diagnosticReceipt, folderMarker: `folder-${host}-${config.nonce}`, clientInfo: mcp.server.getClientVersion(), args, requestId: extra.requestId });
    return { ...(diagnosticReceipt?.accepted === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify({ status: 'synthetic-probe-recorded', diagnosticReceipt }) }] };
  });
  await log(out, { kind: 'server-start', host, folderMarker: `folder-${host}-${config.nonce}` });
  mcp.server.oninitialized = () => { log(out, { kind: 'server-initialized', host, clientInfo: mcp.server.getClientVersion() }).catch((e) => { console.error(e.message); process.exitCode = 1; }); };
  await mcp.connect(new StdioServerTransport());
}

// This adapter is based on test/fixtures/hosts/codex.json, observed CLI 0.162.1.
// Host call ids bind Pre/Post; the echoed one-use server receipt bridges MCP request ids.
async function codexProofs(out, config, all) {
  const hooks = all.filter((e) => e.kind === 'hook' && e.host === 'codex');
  const pres = hooks.filter((e) => e.payload.hook_event_name === 'PreToolUse');
  const posts = hooks.filter((e) => e.payload.hook_event_name === 'PostToolUse');
  const submits = hooks.filter((e) => e.payload.hook_event_name === 'UserPromptSubmit');
  const calls = all.filter((e) => e.kind === 'server-call' && e.host === 'codex');
  const transcripts = new Map();
  for (const e of hooks) {
    const p = e.payload;
    if (p.cwd !== out || !p.session_id || transcripts.has(p.session_id)) continue;
    try {
      const records = await transcript(p);
      if (records.filter((r) => r.type === 'session_meta').length === 1 && records.some((r) => r.type === 'session_meta' && r.payload?.id === p.session_id && r.payload.cwd === out)) transcripts.set(p.session_id, records);
    } catch {} // Missing/unobserved host records never establish a capability.
  }
  const recordsFor = (p) => transcripts.get(p.session_id) ?? [];
  const turnOf = (r) => r.payload?.internal_chat_message_metadata_passthrough?.turn_id;
  const currentUser = (p) => recordsFor(p).some((r) => {
    const q = r.payload, id = r.metadata?.retained_source?.id;
    return r.type === 'response_item' && q?.type === 'message' && q.role === 'user' && turnOf(r) === p.turn_id &&
      id?.turn_id === p.turn_id && id.message_id === q.id && id.role === 'user';
  });
  const identity = (a, b) => ['session_id', 'turn_id', 'tool_use_id', 'tool_name', 'transcript_path', 'cwd'].every((k) => typeof a[k] === 'string' && a[k] && a[k] === b[k]) && a.cwd === out;
  const response = (post) => {
    try {
      const texts = post.payload.tool_response?.content?.filter((c) => c.type === 'text');
      return texts?.length === 1 && !post.payload.tool_response.isError ? JSON.parse(texts[0].text) : null;
    } catch { return null; }
  };
  const matchingSubmit = (p) => submits.filter((e) => e.payload.session_id === p.session_id && e.payload.turn_id === p.turn_id && e.payload.cwd === out && e.payload.transcript_path === p.transcript_path);
  const chains = [];
  for (const pre of pres) {
    const p = pre.payload, u = pre.output?.hookSpecificOutput?.updatedInput;
    if (p.tool_name !== 'mcp__apple_notes_folder__probe_attachment' || p.tool_input?.marker !== 'after' || Object.hasOwn(p.tool_input, 'attachment_ticket') ||
        pre.output?.hookSpecificOutput?.permissionDecision !== 'allow' || u?.attachment_ticket !== 'probe-v1' || !/^probe-after-[0-9a-f-]{36}$/.test(u.marker) || !currentUser(p)) continue;
    const matchingPosts = posts.filter((e) => identity(p, e.payload));
    const matchingCalls = calls.filter((e) => e.args.marker === u.marker);
    if (matchingPosts.length !== 1 || matchingCalls.length !== 1 || pres.filter((e) => e.output?.hookSpecificOutput?.updatedInput?.marker === u.marker).length !== 1 || matchingSubmit(p).length !== 1) continue;
    const post = matchingPosts[0], call = matchingCalls[0], receipt = call.diagnosticReceipt;
    if (!isDeepStrictEqual(u, call.args) || !isDeepStrictEqual(post.payload.tool_input, u) ||
        !receipt?.accepted || receipt.hookEventId !== pre.eventId || receipt.marker !== u.marker || receipt.requestId !== call.requestId || !receipt.serverReceiptId ||
        response(post)?.status !== 'synthetic-probe-recorded' || !isDeepStrictEqual(response(post)?.diagnosticReceipt, receipt)) continue;
    // The server receipt must also be in the actual host tool output of this same turn.
    const echoed = recordsFor(p).some((r) => ['custom_tool_call_output', 'function_call_output'].includes(r.payload?.type) && turnOf(r) === p.turn_id && JSON.stringify(r.payload.output).includes(receipt.serverReceiptId));
    if (echoed) chains.push({ pre, post, call, submit: matchingSubmit(p)[0] });
  }
  const originalBytes = chains.some(({ pre }) => all.some((m) => {
    const p = pre.payload;
    if (m.kind !== 'mutation' || m.phase !== 'image-prepared-before-tool' || m.host !== 'codex' || m.preToolEventId !== pre.eventId || m.session !== p.session_id || m.turnId !== p.turn_id || m.toolUseId !== p.tool_use_id ||
        m.sourceBeforeSha256 !== config.pngSha256 || m.replacementSha256 !== sha(Buffer.from('synthetic replacement after host image preparation'))) return false;
    const meta = recordsFor(p).filter((r) => r.type === 'session_meta');
    const snapshots = [m.beforeImageRecord, m.afterImageRecord, codexAttachment(pre.records, p), codexAttachment(recordsFor(p), p)];
    return snapshots.every((r) => r && codexAttachment([...meta, r], p)?.payload.id === m.imageMessageId &&
      inlineImages(r.payload.content).length === 1 && inlineImages(r.payload.content).every((b) => sha(b) === config.pngSha256) &&
      r.payload.content.some((c) => c.type === 'input_text' && c.text.includes(`path="${out}/image.png"`)));
  }));
  const effectAbsent = async (file) => stat(join(out, file)).then(() => false, (e) => e.code === 'ENOENT');
  function guardProof(command, codeMode) {
    return pres.some((pre) => {
      const p = pre.payload, reason = pre.output?.hookSpecificOutput?.permissionDecisionReason;
      if (p.cwd !== out || p.tool_name !== 'Bash' || p.tool_input?.command !== command || !p.tool_use_id || !currentUser(p) ||
          pre.output?.hookSpecificOutput?.permissionDecision !== 'deny' || reason !== `Synthetic probe guard marker [session=${p.session_id} turn=${p.turn_id} call=${p.tool_use_id}]`) return false;
      const records = recordsFor(p).filter((r) => turnOf(r) === p.turn_id);
      const expectedError = `Command blocked by PreToolUse hook: ${reason}. Command: ${command}`;
      if (!codeMode) {
        const direct = records.filter((r) => r.payload?.type === 'function_call' && r.payload.name === 'exec_command' && r.payload.call_id === p.tool_use_id);
        const results = records.filter((r) => r.payload?.type === 'function_call_output' && r.payload.call_id === p.tool_use_id);
        try { return direct.length === 1 && JSON.parse(direct[0].payload.arguments).cmd === command && results.length === 1 && results[0].payload.output === expectedError; } catch { return false; }
      }
      const outers = records.filter((r) => r.payload?.type === 'custom_tool_call' && r.payload.name === 'exec' && r.payload.input.trim() === `await tools.exec_command(${JSON.stringify({ cmd: command })});`);
      if (outers.length !== 1 || pres.filter((e) => e.payload.session_id === p.session_id && e.payload.turn_id === p.turn_id && e.payload.tool_name === 'Bash').length !== 1) return false;
      const results = records.filter((r) => r.payload?.type === 'custom_tool_call_output' && r.payload.call_id === outers[0].payload.call_id);
      return results.length === 1 && results[0].payload.output?.some((c) => c.type === 'input_text' && c.text === `Script error:\n${expectedError}`);
    });
  }
  return {
    sessionBinding: chains.length > 0,
    rewriteReceived: chains.length > 0,
    originalBytes,
    attachmentRefsVisible: chains.some(({ pre, call, submit }) => typeof submit.payload.prompt === 'string' && !submit.payload.prompt.includes(config.href) &&
      submit.output?.hookSpecificOutput?.additionalContext?.includes(config.href) && call.args.markdown.includes(config.href) && pre.payload.tool_input.markdown.includes(config.href)),
    guardBlocked: guardProof(config.guardCommand, false) && await effectAbsent('guard-effect'),
    codeModeBlocked: guardProof(config.codeGuardCommand, true) && await effectAbsent('code-guard-effect'),
  };
}

export async function report(out) {
  const config = await json(join(out, 'run.json'));
  const all = await events(out);
  const calls = all.filter((e) => e.kind === 'server-call' && e.host === config.client);
  const clientVersions = all.filter((e) => e.host === 'codex' && e.clientInfo?.version).map((e) => e.clientInfo.version);
  const observedCodex = config.client === 'codex' && clientVersions.length > 0 && clientVersions.every((version) => version === '0.162.1');
  const proofs = observedCodex ? await codexProofs(out, config, all) : {};
  // No Claude Pre/PostToolUse or attachment identity contract has been observed yet.
  // Do not combine unrelated raw fields, hashes, or historical transcript text.
  // Future positive adapters must cite real session/message/tool/outer/nested ids
  // and match the one-use marker + server receipt to that exact host call.
  const unverified = {
    sessionBinding: 'No observed host session/transcript/tool-call identity adapter',
    originalBytes: 'No observed mutation submit/message/attachment identity adapter',
    rewriteReceived: 'No observed exact hook-call/server-receipt/PostToolUse identity adapter',
    attachmentRefsVisible: 'No observed submit-to-exact-server-call identity adapter',
    guardBlocked: 'No observed shell call/deny/result identity adapter',
    ...(config.client === 'codex' ? { codeModeBlocked: 'No observed current outer/nested Code Mode call/deny/result identity adapter' } : {}),
  };
  return {
    client: config.client,
    version: all.find((e) => e.host === config.client && e.clientInfo?.version)?.clientInfo.version ?? null,
    sessionBinding: proofs.sessionBinding ?? false,
    originalBytes: proofs.originalBytes ?? false,
    rewriteReceived: proofs.rewriteReceived ?? false,
    attachmentRefsVisible: proofs.attachmentRefsVisible ?? false,
    packagingIsolation: all.some((e) => e.kind === 'server-initialized' && e.host === config.client) && !all.some((e) => e.host && e.host !== config.client),
    guardBlocked: proofs.guardBlocked ?? false,
    ...(config.client === 'codex' ? { codeModeBlocked: proofs.codeModeBlocked ?? false } : {}),
    unverified: Object.fromEntries(Object.entries(unverified).filter(([key]) => !proofs[key]).map(([key, reason]) => [key, observedCodex ? `Observed Codex 0.162.1 adapter did not prove ${key}` : reason])),
    negativeControl: calls.some((e) => e.args.marker === 'before' && !e.args.attachment_ticket),
  };
}
export async function verify(root) {
  const dirs = await readdir(root, { withFileTypes: true });
  const reports = [];
  for (const d of dirs) if (d.isDirectory() && ['claude', 'codex'].includes(d.name)) reports.push(await report(join(root, d.name)));
  const failures = [];
  for (const r of reports) for (const k of ['sessionBinding', 'originalBytes', 'rewriteReceived', 'attachmentRefsVisible', 'packagingIsolation', 'guardBlocked', 'negativeControl', ...(r.client === 'codex' ? ['codeModeBlocked'] : [])]) if (!r[k]) failures.push(`${r.client}: ${k}=false`);
  if (reports.length !== 2) failures.push('reports.length must equal 2');
  return { reports, failures };
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
  if (!opt('out')) throw new Error('--out required');
  const out = resolve(opt('out'));
  if (mode === 'prepare') console.log(JSON.stringify(await prepare(opt('client'), out)));
  else if (mode === 'hook') {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify(await hook(out, opt('host'), JSON.parse(input))));
  } else if (mode === 'server') await server(out, opt('host'));
  else if (mode === 'verify') { const result = await verify(out); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.failures.length ? 1 : 0; }
  else throw new Error('Expected prepare, hook, server, or verify');
}
if (process.argv[1] && resolve(process.argv[1]) === self) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
