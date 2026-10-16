import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const NAMES = ['notes_append', 'notes_create', 'notes_delete', 'notes_list', 'notes_read', 'notes_search', 'notes_update'];

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'notes-smoke-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function connect(env: Record<string, string>, host = 'claude'): Promise<Client> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, '--client', host], env: { ...base, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), ...env } }));
  return client;
}

describe('dist/server.js', () => {
  it.each(['claude', 'codex'])('%s отдаёт семь инструментов и собственную подсказку настройки', async host => {
    const client = await connect({ NOTES_FOLDER: '' }, host);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(NAMES);
      const r = await client.callTool({ name: 'notes_list', arguments: {} });
      expect(r.isError).toBe(true);
      const text = (r.content as { text: string }[])[0].text;
      expect(text).toContain(host === 'codex' ? '$apple-notes-folder:setup' : '/plugin configure');
      if (host === 'codex') expect(text).not.toContain('/plugin configure');
      for (const name of ['notes_delete', 'notes_update']) expect(tools.find(t => t.name === name)!.annotations!.destructiveHint).toBe(true);
      for (const name of ['notes_create', 'notes_append', 'notes_update']) expect(tools.find(t => t.name === name)!.inputSchema.properties).toHaveProperty('attachment_ticket');
    } finally {
      await client.close();
    }
  }, 20_000);

  it('отклоняет аргументы вне лимитов', async () => {
    const client = await connect({ NOTES_FOLDER: '' });
    try {
      const r = await client
        .callTool({ name: 'notes_list', arguments: { limit: 500 } })
        .catch((e: unknown) => ({ isError: true, content: [{ text: String(e) }] }));
      expect(r.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);
});

it('malformed Codex config keeps MCP responding and is read only once per start', async () => {
  const root = join(home, '.codex', 'agent-utils', 'apple-notes-folder');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), '{malformed');
  const client = await connect({ NOTES_FOLDER: '' }, 'codex');
  try {
    expect((await client.listTools()).tools).toHaveLength(7);
    const first = await client.callTool({ name: 'notes_list', arguments: {} });
    expect(first.isError).toBe(true);
    expect((first.content as { text: string }[])[0].text).toContain('повреждена');
    await rm(join(root, 'config.json'));
    const second = await client.callTool({ name: 'notes_list', arguments: {} });
    expect(second).toEqual(first);
  } finally { await client.close(); }
}, 20_000);

it('Codex ignores Claude folder configuration and captures an absent config once', async () => {
  const client = await connect({ NOTES_FOLDER: 'Recently Deleted' }, 'codex');
  try {
    const first = await client.callTool({ name: 'notes_list', arguments: {} });
    expect(first.isError).toBe(true);
    expect((first.content as { text: string }[])[0].text).toContain('Не задана');
    const root = join(home, '.codex', 'agent-utils', 'apple-notes-folder');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, folder: 'Recently Deleted' }));
    expect(await client.callTool({ name: 'notes_list', arguments: {} })).toEqual(first);
  } finally { await client.close(); }
}, 20_000);
