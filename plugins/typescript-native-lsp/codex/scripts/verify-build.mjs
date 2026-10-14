import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOptions } from './build-options.mjs';

const out = await mkdtemp(join(tmpdir(), 'typescript-native-lsp-build-'));
try {
  await build(buildOptions(out));
  const built = (await readdir(out)).sort();
  const committed = (await readdir('dist')).sort();
  assert.deepEqual(built, ['server.js'], 'build contains exactly one server.js');
  assert.deepEqual(committed, built, 'dist file composition matches fresh build');
  for (const file of built) {
    assert.ok((await readFile(join(out, file))).equals(await readFile(join('dist', file))), `dist/${file} matches fresh build bytes`);
  }
  console.log(`dist matches fresh build: ${built.length} file, byte-for-byte`);
} finally {
  await rm(out, { recursive: true, force: true });
}
