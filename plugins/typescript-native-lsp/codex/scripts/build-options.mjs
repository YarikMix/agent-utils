/** @param {string} outdir @returns {import('esbuild').BuildOptions} */
export function buildOptions(outdir) {
  return {
    entryPoints: { server: 'src/index.ts' },
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    legalComments: 'eof',
    logLevel: 'warning',
  };
}
