import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const artifacts = resolve('.native-test-artifacts');
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'ts7 native acceptance '));
const prefix = join(temporary, 'global prefix');
const userConfig = join(temporary, 'empty-user.npmrc');
const globalConfig = join(temporary, 'empty-global.npmrc');
await Promise.all([writeFile(userConfig, ''), writeFile(globalConfig, '')]);
const log = createWriteStream(join(artifacts, 'runner.log'));
let exitCode = 1;
async function run(args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
    child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
    child.once('error', reject);
    child.once('close', code => resolveRun(code ?? 1));
  });
}
try {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run this acceptance runner through npm run test:live');
  console.log(`Native acceptance: ${process.platform}/${process.arch}, Node ${process.version}, TypeScript 7.0.2`);
  exitCode = await run([npm, 'install', '--global', '--prefix', prefix, '--userconfig', userConfig, '--globalconfig', globalConfig,
    '--cache', join(temporary, 'npm-cache'), '--fetch-retries=0', '--fetch-timeout=15000', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', 'typescript@7.0.2']);
  if (!exitCode) exitCode = await run(['--import', 'tsx', '--test', ...process.argv.slice(2), 'test/native.test.ts'], {
    ...process.env, NATIVE_TEST_PREFIX: prefix, NATIVE_TEST_ARTIFACTS: artifacts,
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
  await new Promise(resolveClose => log.end(resolveClose));
  console.log(`Native ${exitCode === 0 ? 'acceptance' : 'failure'} artifacts: ${artifacts}`);
}
process.exitCode = exitCode;
