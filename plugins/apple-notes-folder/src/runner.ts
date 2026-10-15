import { execFile } from 'node:child_process';
import { CONFIGURE_HINT, MESSAGES, ToolError, attachmentsMessage } from './errors.js';

export interface RunOptions {
  write: boolean;
}
export type Runner = (script: string, args: string[], opts: RunOptions) => Promise<string>;

export const OSA_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

type ExecCallback = (err: (Error & { killed?: boolean; signal?: string | null }) | null, stdout: string, stderr: string) => void;
export type ExecFn = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }, cb: ExecCallback) => unknown;

export function mapOsaFailure(err: { killed?: boolean; signal?: string | null }, stderr: string, write: boolean, hint: string = CONFIGURE_HINT): ToolError {
  const timeout = () => new ToolError(write ? 'TIMEOUT_WRITE' : 'TIMEOUT', write ? MESSAGES.TIMEOUT_WRITE : MESSAGES.TIMEOUT);
  if (err.killed || err.signal === 'SIGTERM') return timeout();

  const apn = /APN:([A-Z_]+)(?::(\d+))?/.exec(stderr);
  const code = apn?.[1];
  switch (code) {
    case 'ATTACHMENTS':
      return new ToolError('ATTACHMENTS', attachmentsMessage(Number(apn?.[2] ?? 0)));
    case 'LISTS':
      return new ToolError('LISTS', MESSAGES.LISTS);
    case 'OUTSIDE':
      return new ToolError('OUTSIDE', MESSAGES.OUTSIDE);
    case 'NOT_FOUND':
      return new ToolError('NOT_FOUND', MESSAGES.NOT_FOUND);
    case 'LOCKED':
      return new ToolError('LOCKED', MESSAGES.LOCKED);
    case 'FOLDER_GONE':
      return new ToolError('CONFIG', MESSAGES.FOLDER_GONE.replace(CONFIGURE_HINT, hint));
    case 'IO':
      return new ToolError('OSA', MESSAGES.IO);
  }
  if (/-1743|not authori[sz]ed/i.test(stderr)) return new ToolError('PERMISSION', MESSAGES.PERMISSION);
  if (/-1712/.test(stderr)) return timeout();
  return new ToolError('OSA', `Ошибка Заметок: ${stderr.trim().slice(0, 500)}`);
}

/** Запускает постоянный JXA-скрипт; args уходят в argv функции run, не в текст скрипта. */
export function makeOsascriptRunner(exec: ExecFn = execFile as unknown as ExecFn, hint: string = CONFIGURE_HINT): Runner {
  return (script, args, { write }) =>
    new Promise((resolve, reject) => {
      exec(
        'osascript',
        ['-l', 'JavaScript', '-e', script, ...args],
        { timeout: OSA_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (err, stdout, stderr) => {
          if (err) reject(mapOsaFailure(err, String(stderr ?? ''), write, hint));
          else resolve(String(stdout).trim());
        },
      );
    });
}
