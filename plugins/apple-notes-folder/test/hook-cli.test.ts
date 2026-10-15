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
it('rebuilt CLI honors explicit Codex host and publishes a grant in that isolated runtime', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hosts/codex.json', import.meta.url), 'utf8'));
  const records = fixture.transcriptRecords.slice(fixture.transcriptRecords.findLastIndex((r: any) => r.type === 'session_meta'));
  const transcript = join(dir, 'transcript.jsonl');
  await writeFile(transcript, records.map((r: unknown) => JSON.stringify(r)).join('\n'));
  const raw = { ...fixture.preToolUse.at(-1), session_id: records[0].payload.id, transcript_path: transcript, tool_name: 'mcp__apple_notes_folder__notes_create', tool_input: { title: 'Image', markdown: '![](attachment:c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77)' } };
  const result = spawnSync(process.execPath, [cli, '--client', 'codex'], { input: JSON.stringify(raw), encoding: 'utf8', env: { ...process.env, CODEX_HOME: dir } });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  expect(out).toMatchObject({ permissionDecision: 'allow', updatedInput: raw.tool_input });
  const manifest = JSON.parse(await readFile(join(dir, 'agent-utils/apple-notes-folder/runtime/tickets', `${out.updatedInput.attachment_ticket}.json`), 'utf8'));
  expect(manifest.host).toBe('codex');
});
it('CLI rejects unknown client without stdout protocol noise', () => {
  const result = spawnSync(process.execPath, [cli, '--client', 'foreign'], { input: '{}', encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
});
