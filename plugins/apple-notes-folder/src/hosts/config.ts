import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ToolError } from '../errors.js';
import type { Runner } from '../runner.js';
import { configuredFolder, resolveScope, type Scope } from '../scope.js';
import { configurationHint, hostPaths } from './paths.js';
import type { Host } from './types.js';

export async function readFolder(host: Host, env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  if (host === 'claude') return configuredFolder(env);
  const { configFile } = hostPaths(host, env, home);
  let raw: string;
  try {
    raw = await readFile(configFile!, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ToolError('CONFIG', `Не удалось прочитать настройку папки. Повторите настройку: ${configurationHint(host)}.`);
  }

  try {
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== 'object' || !('version' in config) || config.version !== 1
      || !('folder' in config) || typeof config.folder !== 'string' || !config.folder.trim()) {
      throw new Error('Invalid config');
    }
    return config.folder;
  } catch {
    throw new ToolError('CONFIG', `Настройка папки повреждена или имеет неизвестный формат. Повторите настройку: ${configurationHint(host)}.`);
  }
}

export async function configureCodex(folder: string, env: NodeJS.ProcessEnv, home: string, run: Runner): Promise<Scope> {
  const scope = await resolveScope(folder.trim() || null, run, configurationHint('codex'));
  const { configFile } = hostPaths('codex', env, home);
  const configDir = dirname(configFile!);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(dirname(configDir), 0o700);
  await chmod(configDir, 0o700);
  const temporary = join(configDir, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, folder: scope.folderName })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, configFile!);
  } finally {
    await rm(temporary, { force: true });
  }
  return scope;
}
