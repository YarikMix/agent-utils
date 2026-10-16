import { homedir } from 'node:os';
import { runHook } from './hook.js';
import { hostPaths, parseHost } from './hosts/paths.js';

const host = parseHost(process.argv.slice(2));
const paths = hostPaths(host, process.env, homedir());
let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(await runHook(host, input, paths));
