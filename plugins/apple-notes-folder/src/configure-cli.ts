import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolError } from './errors.js';
import { configureCodex } from './hosts/config.js';
import { makeOsascriptRunner, type Runner } from './runner.js';

export async function runConfigureCli(argv: string[], env: NodeJS.ProcessEnv, home: string, run: Runner): Promise<string> {
  if (argv.length !== 2 || argv[0] !== '--folder' || !argv[1].trim() || argv[1].startsWith('--')) {
    throw new ToolError('CONFIG', 'Укажите папку: --folder <имя>.');
  }
  await configureCodex(argv[1], env, home, run);
  return 'Папка настроена. Перезапустите MCP-сервер Apple Notes.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  runConfigureCli(process.argv.slice(2), process.env, homedir(), makeOsascriptRunner()).then(
    (status) => { console.log(status); },
    (error: unknown) => {
      console.error(error instanceof ToolError ? error.message : 'Не удалось настроить папку Apple Notes.');
      process.exitCode = 1;
    },
  );
}
