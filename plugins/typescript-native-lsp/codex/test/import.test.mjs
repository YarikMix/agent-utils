import assert from 'node:assert/strict';
import { copyFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedTools = ['hover', 'diagnostics', 'references', 'outline', 'rename', 'inlay_hints', 'definition', 'workspace_symbols', 'implementations', 'prepare_call_hierarchy', 'incoming_calls', 'outgoing_calls'].sort();

test('pinned standalone import has metadata, twelve tools and real native hover', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const upstream = await readFile(join(root, 'UPSTREAM.md'), 'utf8');
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  assert.equal(pkg.private, true);
  assert.equal(pkg.name, 'typescript-native-lsp-codex');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.version, '1.1.0');
  assert.match(upstream, /039e5f38503eb5ace3a82a4a55fb6d5e7dce3ce1/);
  assert.match(license, /Copyright \(c\) Zach Sents/);
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], '1.32.1');
  assert.equal(pkg.dependencies.zod, '4.3.6');
  assert.equal(pkg.devDependencies.typescript, '7.0.2');
  assert.equal(pkg.devDependencies.esbuild, '0.28.2');
  const lockText = await readFile(join(root, 'package-lock.json'), 'utf8');
  assert.doesNotMatch(JSON.stringify(pkg) + lockText, /workspace:/);
  const lock = JSON.parse(lockText);
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolved) assert.ok(entry.resolved.startsWith('https://registry.npmjs.org/'));
  }

  // Metadata is checked before loading the TypeScript runner or MCP dependencies.
  const { openMcp, temporaryProject, devNativeBinary } = await import('./support.ts');
  const sample = await readFile(join(root, 'test/sample.ts'), 'utf8');
  const fixture = await temporaryProject({ 'sample.ts': sample });
  const copied = await temporaryProject({});
  try {
    await copyFile(join(root, 'dist/server.js'), join(copied.root, 'server.mjs'));
    const TSC_PATH = devNativeBinary();
    assert.ok(TSC_PATH, 'explicit native TSC_PATH is available');
    for (const entryPath of [join(root, 'dist/server.js'), join(copied.root, 'server.mjs')]) {
      const session = await openMcp(entryPath, { ...process.env, TSC_PATH });
      try {
        const { tools } = await session.client.listTools();
        assert.equal(tools.length, 12);
        assert.deepEqual(tools.map(t => t.name).sort(), expectedTools);
        const hover = await session.client.callTool({ name: 'hover', arguments: {
          file: join(fixture.root, 'sample.ts'), line: 12, character: 4,
        } });
        assert.notEqual(hover.isError, true);
        const hoverText = hover.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        assert.match(hoverText, /number/);
      } finally {
        // Upstream EOF handling is intentionally unchanged until the lifetime task.
        await session.close();
      }
    }
  } finally {
    await Promise.all([fixture.dispose(), copied.dispose()]);
  }
});
