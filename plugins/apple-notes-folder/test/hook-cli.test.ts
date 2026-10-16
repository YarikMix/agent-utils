import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../dist/hook.js', import.meta.url));
let dir: string;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'notes-hook-cli-'))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
it.each(['codex', 'claude'] as const)('rebuilt %s CLI rewrites notes_update without granting permission (Claude envelope synthetic/documented)', async host => {
  const fixture = JSON.parse(await readFile(new URL(`./fixtures/hosts/${host}.json`, import.meta.url), 'utf8'));
  const records = host === 'claude'
    ? JSON.parse(await readFile(new URL('./fixtures/hosts/claude-authfailed-transcript.json', import.meta.url), 'utf8')).transcriptRecords
    : fixture.transcriptRecords.slice(fixture.transcriptRecords.findLastIndex((r: any) => r.type === 'session_meta'));
  const transcript = join(dir, 'transcript.jsonl');
  await writeFile(transcript, records.map((r: unknown) => JSON.stringify(r)).join('\n'));
  const raw = {
    ...(host === 'claude' ? fixture.userPromptSubmit : fixture.preToolUse.at(-1)),
    hook_event_name: 'PreToolUse', tool_use_id: 'own-update',
    session_id: host === 'claude' ? fixture.userPromptSubmit.session_id : records[0].payload.id,
    transcript_path: transcript,
    tool_name: host === 'claude' ? 'mcp__plugin_apple-notes-folder_apple-notes-folder__notes_update' : 'mcp__apple_notes_folder__notes_update',
    tool_input: { id: 'own-note', markdown: '![](attachment:c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77)' },
  };
  const result = spawnSync(process.execPath, [cli, '--client', host], { input: JSON.stringify(raw), encoding: 'utf8', env: { ...process.env, CODEX_HOME: dir, CLAUDE_CONFIG_DIR: dir } });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  expect(out).toMatchObject({ updatedInput: raw.tool_input });
  if (host === 'claude') expect(out).not.toHaveProperty('permissionDecision');
  else expect(out.permissionDecision).toBe('allow'); // Codex rewrite gate; client approval is separate.
  const manifest = JSON.parse(await readFile(join(dir, 'agent-utils/apple-notes-folder/runtime/tickets', `${out.updatedInput.attachment_ticket}.json`), 'utf8'));
  expect(manifest.host).toBe(host);
  expect(manifest.tool).toBe('notes_update');
});
it('CLI rejects unknown client without stdout protocol noise', () => {
  const result = spawnSync(process.execPath, [cli, '--client', 'foreign'], { input: '{}', encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
});
