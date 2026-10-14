import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const selected = process.argv.slice(2);
const files = selected.length ? selected : (await readdir('test'))
  .filter(file => file === 'import.test.mjs' || (file.endsWith('.test.ts') && file !== 'native.test.ts'))
  .sort().map(file => `test/${file}`);
if (files.length === 0) throw new Error('No test files selected');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit', shell: false });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
