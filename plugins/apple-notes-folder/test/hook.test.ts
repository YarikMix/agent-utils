import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldDeny, hookOutput, runHook, DENY_REASON } from '../src/hook.js';

const DENY = [
  `osascript -e 'tell application "Notes" to get name of every note'`,
  `osascript -l JavaScript -e "Application('Notes').notes()"`,
  `sqlite3 ~/Library/Group\\ Containers/group.com.apple.notes/NoteStore.sqlite 'select 1'`,
  'echo x | OSASCRIPT - com.apple.Notes',
  `osascript -e "tell application \\"Notes\\" to get name of every note"`,
  `osascript <<'EOF'
tell application "Notes" to count notes
EOF`,
  `osascript -e 'tell application id "com.apple.Notes" to count notes'`,
  `osascript -e 'tell application "Notes.app" to count notes'`,
  `osascript -e 'tell application "/System/Applications/Notes.app" to count notes'`,
];
const ALLOW = [
  'git log --oneline',
  'grep Notes README.md',
  `osascript -e 'display dialog "hi"'`,
  'npm test',
  'sqlite3 app.db .tables',
  'cat .superpowers/sdd/x/apple-notes-folder-brief.md | grep osascript',
  'git commit -m "feat(apple-notes-folder): osascript runner for Notes"',
];

const DENY_JSON = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
};

describe('shouldDeny', () => {
  it.each(DENY)('отклоняет: %s', (c) => expect(shouldDeny(c)).toBe(true));
  it.each(ALLOW)('пропускает: %s', (c) => expect(shouldDeny(c)).toBe(false));
});

describe('hookOutput', () => {
  it('возвращает JSON отказа для запрещённого вызова Bash', () => {
    const out = hookOutput(JSON.stringify({ tool_name: 'Bash', tool_input: { command: DENY[0] } }));
    expect(JSON.parse(out)).toEqual(DENY_JSON);
  });

  it('возвращает пустую строку для обычной команды', () => {
    expect(hookOutput(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))).toBe('');
  });

  it('возвращает пустую строку для не-JSON на входе', () => {
    expect(hookOutput('не json')).toBe('');
  });

  it('возвращает пустую строку для пустого входа', () => {
    expect(hookOutput('')).toBe('');
  });

  it('Monitor тоже несёт shell-команду в tool_input.command — запрещённая отклоняется', () => {
    const out = hookOutput(JSON.stringify({ tool_name: 'Monitor', tool_input: { command: DENY[0] } }));
    expect(JSON.parse(out)).toEqual(DENY_JSON);
  });

  it('Monitor с обычной командой — пустая строка', () => {
    expect(hookOutput(JSON.stringify({ tool_name: 'Monitor', tool_input: { command: 'ls' } }))).toBe('');
  });

  it('не-shell инструмент (например, Read с {file_path}) — пустая строка', () => {
    expect(hookOutput(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: DENY[0] } }))).toBe('');
  });
});

describe('dist/hook.js', () => {
  const HOOK = fileURLToPath(new URL('../dist/hook.js', import.meta.url));
  const run = (input: string) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });

  it('печатает отказ для обхода через Bash', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: DENY[0] } }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(DENY_JSON);
  });

  it('молчит для обычной команды и мусора на входе', () => {
    for (const input of [JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), 'не json', '']) {
      const r = run(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('срабатывает при запуске через симлинк', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apple-notes-folder-hook-'));
    try {
      const link = join(dir, 'x.js');
      await symlink(HOOK, link);
      const r = spawnSync(process.execPath, [link], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: DENY[0] } }),
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(DENY_JSON);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe('async shell composition', () => {
  const paths = { configFile: null, runtimeDir: '/unused/runtime' };
  it.each(['claude', 'codex'] as const)('%s denies normalized shell before attachment parsing', async host => {
    const raw = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: DENY[0] }, transcript_path: '/nonexistent' };
    expect(JSON.parse(await runHook(host, JSON.stringify(raw), paths))).toEqual(DENY_JSON);
  });
  it('preserves Claude Monitor and never treats Code Mode JavaScript as shell command', async () => {
    expect(JSON.parse(await runHook('claude', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { command: DENY[0] } }), paths))).toEqual(DENY_JSON);
    expect(await runHook('codex', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { code: DENY[0], command: DENY[0] } }), paths)).toBe('');
  });
  it('ignores invalid JSON and unrelated events', async () => {
    expect(await runHook('codex', 'invalid', paths)).toBe('');
    expect(await runHook('claude', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: DENY[0] } }), paths)).toBe('');
  });
});
