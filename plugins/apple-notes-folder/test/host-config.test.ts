import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationHint, hostPaths, parseHost } from '../src/hosts/paths.js';
import { configureCodex, readFolder } from '../src/hosts/config.js';
import { makeScopeProvider, resolveScope } from '../src/scope.js';
import type { Runner } from '../src/runner.js';

let home: string;
let codexHome: string;
let run: Runner;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'notes-host-config-'));
  await chmod(home, 0o700);
  codexHome = join(home, 'codex-profile');
  run = async () => JSON.stringify([
    { id: 'C1', name: 'ClaudeFolder', account: 'iCloud' },
    { id: 'C2', name: 'CodexFolder', account: 'iCloud' },
  ]);
});

afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('host selection and paths', () => {
  it('defaults to Claude and accepts only an explicit supported client', () => {
    expect(parseHost([])).toBe('claude');
    expect(parseHost(['--client', 'claude'])).toBe('claude');
    expect(parseHost(['--client', 'codex'])).toBe('codex');
    for (const args of [['--client', 'other'], ['--client'], ['codex'], ['--other'], ['--client', 'codex', '--client', 'claude']]) {
      expect(() => parseHost(args)).toThrow();
    }
  });

  it('derives separate runtime and config paths from the supplied home', () => {
    expect(hostPaths('claude', {}, home)).toEqual({
      configFile: null,
      runtimeDir: join(home, '.claude/agent-utils/apple-notes-folder/runtime'),
    });
    expect(hostPaths('codex', {}, home)).toEqual({
      configFile: join(home, '.codex/agent-utils/apple-notes-folder/config.json'),
      runtimeDir: join(home, '.codex/agent-utils/apple-notes-folder/runtime'),
    });
    const env = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(home, 'claude-profile'), HOME: '/not-the-home' };
    expect(hostPaths('codex', env, home).runtimeDir).toBe(join(codexHome, 'agent-utils/apple-notes-folder/runtime'));
    expect(hostPaths('claude', env, home).runtimeDir).toBe(join(home, 'claude-profile/agent-utils/apple-notes-folder/runtime'));
    expect(hostPaths('codex', { CODEX_HOME: '~/literal' }, home).configFile).toBe('~/literal/agent-utils/apple-notes-folder/config.json');
    expect(hostPaths('claude', { CLAUDE_CONFIG_DIR: '' }, home)).toEqual(hostPaths('claude', {}, home));
    expect(hostPaths('codex', { CODEX_HOME: '' }, home)).toEqual(hostPaths('codex', {}, home));
    expect(env.HOME).toBe('/not-the-home');
  });
});

describe('readFolder', () => {
  it('keeps Claude userConfig and Codex configuration independent', async () => {
    await configureCodex('CodexFolder', { CODEX_HOME: codexHome }, home, run);
    expect(await readFolder('claude', { NOTES_FOLDER: ' ClaudeFolder ', CODEX_HOME: codexHome }, home)).toBe('ClaudeFolder');
    expect(await readFolder('codex', { NOTES_FOLDER: 'Wrong', CODEX_HOME: codexHome }, home)).toBe('CodexFolder');
    expect(await readFolder('claude', {}, home)).toBeNull();
  });

  it('returns null for a missing Codex config even when NOTES_FOLDER is set', async () => {
    expect(await readFolder('codex', { NOTES_FOLDER: 'Wrong', CODEX_HOME: codexHome }, home)).toBeNull();
  });

  it.each(['{bad', '{"version":2,"folder":"CodexFolder"}', 'null', '[]', '{"version":1}', '{"version":1,"folder":3}', '{"version":1,"folder":"   "}'])(
    'reports invalid config as CONFIG: %s', async (content) => {
      const dir = join(codexHome, 'agent-utils/apple-notes-folder');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'config.json'), content, { mode: 0o600 });
      await expect(readFolder('codex', { CODEX_HOME: codexHome }, home)).rejects.toMatchObject({ code: 'CONFIG' });
      await expect(readFolder('codex', { CODEX_HOME: codexHome }, home)).rejects.toThrow('$apple-notes-folder:setup');
    },
  );

  it('keeps persisted configuration when disposable runtime/cache is removed', async () => {
    await configureCodex('CodexFolder', { CODEX_HOME: codexHome }, home, run);
    const { runtimeDir } = hostPaths('codex', { CODEX_HOME: codexHome }, home);
    await mkdir(join(runtimeDir, 'cache'), { recursive: true, mode: 0o700 });
    await writeFile(join(runtimeDir, 'cache/file'), 'cache', { mode: 0o600 });
    await rm(runtimeDir, { recursive: true });
    expect(await readFolder('codex', { CODEX_HOME: codexHome }, home)).toBe('CodexFolder');
    expect(JSON.parse(await readFile(join(codexHome, 'agent-utils/apple-notes-folder/config.json'), 'utf8'))).toEqual({ version: 1, folder: 'CodexFolder' });
  });
});

describe('configuration hints', () => {
  it('uses the host setup command on every scope configuration failure', async () => {
    expect(configurationHint('claude')).toBe('/plugin configure apple-notes-folder@yarikmix-plugins');
    const hint = configurationHint('codex');
    expect(hint).toBe('$apple-notes-folder:setup');
    await expect(resolveScope(null, run, hint)).rejects.toThrow(hint);
    await expect(resolveScope('Missing', run, hint)).rejects.toThrow(hint);
    const ambiguous: Runner = async () => JSON.stringify([
      { id: '1', name: 'Dup', account: 'iCloud' }, { id: '2', name: 'Dup', account: 'Local' },
    ]);
    await expect(resolveScope('Dup', ambiguous, hint)).rejects.toThrow(hint);
    await expect(makeScopeProvider(null, run, hint)()).rejects.toThrow(hint);
  });
});
