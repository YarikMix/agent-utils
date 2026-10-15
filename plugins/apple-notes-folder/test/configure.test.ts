import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureCodex } from '../src/hosts/config.js';
import { runConfigureCli } from '../src/configure-cli.js';
import { SCRIPTS } from '../src/scripts.js';
import type { Runner } from '../src/runner.js';

let home: string;
let codexHome: string;
let configFile: string;
let run: Runner;
let calls: number;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'notes-configure-'));
  await chmod(home, 0o700);
  codexHome = join(home, 'codex-profile');
  configFile = join(codexHome, 'agent-utils/apple-notes-folder/config.json');
  calls = 0;
  run = async (script, args, options) => {
    calls++;
    expect(script).toBe(SCRIPTS.listFolders);
    expect(args).toEqual([]);
    expect(options).toEqual({ write: false });
    return JSON.stringify([
      { id: 'C1', name: 'ClaudeFolder', account: 'iCloud' },
      { id: 'C2', name: 'CodexFolder', account: 'iCloud' },
      { id: 'D1', name: 'Duplicate', account: 'iCloud' },
      { id: 'D2', name: 'Duplicate', account: 'Local' },
    ]);
  };
});

afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('configureCodex', () => {
  it('validates through read-only listFolders and writes the versioned private config', async () => {
    expect(await configureCodex(' CodexFolder ', { CODEX_HOME: codexHome }, home, run)).toEqual({ folderId: 'C2', folderName: 'CodexFolder' });
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({ version: 1, folder: 'CodexFolder' });
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(configFile))).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(dirname(configFile)))).mode & 0o777).toBe(0o700);
    expect(await readdir(dirname(configFile))).toEqual(['config.json']);
  });

  it.each(['', '   ', 'Recently Deleted', 'Недавно удалённые', 'Missing', 'Duplicate'])(
    'preserves exact previous bytes for invalid folder %j', async (folder) => {
      await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
      const previous = '{ "version": 1, "folder": "ClaudeFolder" }\n';
      await writeFile(configFile, previous, { mode: 0o600 });
      await expect(configureCodex(folder, { CODEX_HOME: codexHome }, home, run)).rejects.toMatchObject({ code: 'CONFIG' });
      expect(await readFile(configFile, 'utf8')).toBe(previous);
      expect(await readdir(dirname(configFile))).toEqual(['config.json']);
      expect(calls).toBe(folder.trim() && !/deleted|удалённые/i.test(folder) ? 1 : 0);
    },
  );

  it('does not publish config when Notes validation fails', async () => {
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    await writeFile(configFile, 'previous bytes', { mode: 0o600 });
    const unavailable: Runner = async () => { throw new Error('Notes unavailable'); };
    await expect(configureCodex('CodexFolder', { CODEX_HOME: codexHome }, home, unavailable)).rejects.toThrow('Notes unavailable');
    expect(await readFile(configFile, 'utf8')).toBe('previous bytes');
  });

  it('atomically replaces an existing config and closes its directory permissions', async () => {
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    await chmod(dirname(configFile), 0o755);
    await writeFile(configFile, 'old bytes', { mode: 0o644 });
    let originalSeen = false;
    const inspect: Runner = async (...args) => {
      originalSeen = (await readFile(configFile, 'utf8')) === 'old bytes';
      return run(...args);
    };
    await configureCodex('CodexFolder', { CODEX_HOME: codexHome }, home, inspect);
    expect(originalSeen).toBe(true);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(configFile))).mode & 0o777).toBe(0o700);
    expect(await readdir(dirname(configFile))).toEqual(['config.json']);
  });

  it('removes its unpublished temp file when rename fails', async () => {
    await mkdir(configFile, { recursive: true, mode: 0o700 });
    await expect(configureCodex('CodexFolder', { CODEX_HOME: codexHome }, home, run)).rejects.toThrow();
    expect((await stat(configFile)).isDirectory()).toBe(true);
    expect(await readdir(dirname(configFile))).toEqual(['config.json']);
  });
});

describe('configure CLI', () => {
  it('configures only the requested folder and returns status with an MCP restart reminder', async () => {
    const status = await runConfigureCli(['--folder', 'CodexFolder'], { CODEX_HOME: codexHome }, home, run);
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({ version: 1, folder: 'CodexFolder' });
    expect(status).toMatch(/настроена/i);
    expect(status).toMatch(/перезапустите.*MCP/i);
    expect(status).not.toContain(configFile);
    expect(status).not.toContain('C2');
  });

  it.each([[], ['--folder'], ['--folder', ''], ['--folder', '   '], ['--reset'], ['--all-folders'], ['--folder', '--reset'], ['--folder', 'CodexFolder', '--all-folders']].map((args) => ({ args })))(
    'rejects invalid arguments without calling Notes: $args', async ({ args }) => {
      await expect(runConfigureCli(args, { CODEX_HOME: codexHome }, home, run)).rejects.toMatchObject({ code: 'CONFIG' });
      expect(calls).toBe(0);
      await expect(stat(configFile)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
