import { join } from 'node:path';
import { CODEX_CONFIGURE_HINT, CONFIGURE_HINT, ToolError } from '../errors.js';
import type { Host, RuntimePaths } from './types.js';

export function parseHost(argv: string[]): Host {
  if (argv.length === 0) return 'claude';
  if (argv.length === 2 && argv[0] === '--client' && (argv[1] === 'claude' || argv[1] === 'codex')) return argv[1];
  throw new ToolError('CONFIG', 'Укажите клиент: --client claude|codex.');
}

export function hostPaths(host: Host, env: NodeJS.ProcessEnv, home: string): RuntimePaths {
  const root = host === 'codex'
    ? env.CODEX_HOME || join(home, '.codex')
    : env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const pluginDir = join(root, 'agent-utils', 'apple-notes-folder');
  return {
    configFile: host === 'codex' ? join(pluginDir, 'config.json') : null,
    runtimeDir: join(pluginDir, 'runtime'),
  };
}

export function configurationHint(host: Host): string {
  return host === 'codex' ? CODEX_CONFIGURE_HINT : CONFIGURE_HINT;
}
