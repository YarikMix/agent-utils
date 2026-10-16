/** Общие параметры esbuild для сборки и для её проверки. */
export function buildOptions(outdir) {
  return {
    entryPoints: { server: 'src/server.ts', hook: 'src/hook-cli.ts', configure: 'src/configure-cli.ts' },
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // CJS-зависимости (turndown) внутри ESM-бандла зовут require.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    legalComments: 'eof',
    logLevel: 'warning',
  };
}
