#!/usr/bin/env node
/** Development-only host-contract probe. Never connects to Apple Notes. */
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  await save(join(out, 'controls.json'), { rewrite: false, mutateOnSubmit: false });
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
  await privateFile(join(out, 'guard-command.txt'), config.guardCommand + '\n');
  await privateFile(join(out, 'code-guard-command.txt'), config.codeGuardCommand + '\n');
  await log(out, { kind: 'prepared', client, pngSha256: config.pngSha256 });
  return { out, plugin, prompt: join(out, 'prompt.txt'), image: join(out, 'image.png') };
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
  if (event === 'PreToolUse' && /probe_attachment$/.test(payload.tool_name ?? '') && controls.rewrite && input.marker === 'after' && !input.attachment_ticket) {
    const marker = `probe-after-${randomUUID()}`;
    await save(join(out, 'markers', `${marker}.json`), { eventId, host, originalInput: input, rawHookPayload: payload });
    output = { hookSpecificOutput: { hookEventName: event, permissionDecision: 'allow', updatedInput: { ...input, marker, attachment_ticket: 'probe-v1' } } };
  }
  if (event === 'PreToolUse' && payload.tool_name === 'Bash' && [config.guardCommand, config.codeGuardCommand].includes(input.command)) {
    output = { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: 'Synthetic probe guard marker' } };
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

export async function report(out) {
  const config = await json(join(out, 'run.json'));
  const all = await events(out);
  const calls = all.filter((e) => e.kind === 'server-call' && e.host === config.client);
  // No Pre/PostToolUse or attachment identity contract has been observed yet.
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
    sessionBinding: false,
    originalBytes: false,
    rewriteReceived: false,
    attachmentRefsVisible: false,
    packagingIsolation: all.some((e) => e.kind === 'server-initialized' && e.host === config.client) && !all.some((e) => e.host && e.host !== config.client),
    guardBlocked: false,
    ...(config.client === 'codex' ? { codeModeBlocked: false } : {}),
    unverified,
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
