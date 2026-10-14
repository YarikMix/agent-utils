# Pinned upstream import

- Repository: https://github.com/zachsents/zachs-tools
- Commit: `039e5f38503eb5ace3a82a4a55fb6d5e7dce3ce1`
- Package directory: `packages/ts-mcp`
- Package version: `0.3.7`; author: Zach Sents; license: MIT.
- Local package: `typescript-native-lsp-codex@1.1.0` (private).

Files were fetched with `gh api repos/zachsents/zachs-tools/contents/<path>?ref=039e5f38503eb5ace3a82a4a55fb6d5e7dce3ce1` using `Accept: application/vnd.github.raw+json`. No npm distribution, fork, submodule, floating branch or synchronization process was used as source.

The upstream package and repository root contain no ts-mcp LICENSE file at this commit. `package.json` declares MIT and the README says “MIT — Zach Sents”. The local LICENSE supplies the standard MIT text with `Copyright (c) Zach Sents`, without inventing a year. A LICENSE in a different upstream package is not treated as the ts-mcp license.

## File mapping and transformations

| Upstream path relative to packages/ts-mcp | Local destination | Transformation |
| --- | --- | --- |
| src/index.ts | src/index.ts | Six tool schemas/handlers and metadata retained; pass a lazy compiler resolver to the pool. |
| src/lsp-client.ts | src/lsp-client.ts | Bun Timer type → ReturnType<typeof setTimeout>; otherwise unmodified. |
| src/pool.ts | src/pool.ts | Bun Timer types → ReturnType<typeof setTimeout>; resolve the native compiler asynchronously on first client creation. |
| src/resolve-binary.ts | src/resolve-binary.ts | Replace checkout-package resolution with global PATH/npm launcher discovery or absolute native TSC_PATH; canonicalize PATH and skip local .bin aliases; bound native package lookup to package-local or hoisted global sibling dependencies and reject canonical package/binary targets outside the global node_modules tree; reject wrappers; probe TypeScript 7+ directly with shell=false, bounded output and a 5 s timeout. |
| test/sample.ts | test/sample.ts | Unmodified fixture. |
| test/smoke.ts | test/smoke.ts | Run with Node/tsx; explicit development native TSC_PATH; URL-based fixture path for Node 20; assertions/finally shutdown; await asynchronous resolution and pass a lazy callback. |
| package.json | package.json | Private local name/version, Node >=20; runtime SDK 1.27.1/Zod 4.3.6; TypeScript 7.0.2 moved to dev; esbuild 0.28.2, tsx 4.23.15, @types/node 20.19.43 exact; independent build/test scripts; remove Bun/oxlint/eslint/workspace/shx/publishing scripts. |
| README.md | README.md and snapshot below | Local README describes this imported stage; verbatim original retained as historical source below. |
| tsconfig.json, tsconfig.build.json | tsconfig.json and snapshots below | Consolidated NodeNext strict noEmit config, ES2022 target, Node types; include src/test harness, exclude sample/fixtures; esbuild handles emit. |
| .gitignore | .gitignore | Only local node_modules ignored; bundled dist tracked. |

New local files: `.npmrc`, public `package-lock.json`, `scripts/{build-options,build,verify-build,test}.mjs`, `test/{support.ts,import.test.mjs,resolve-binary.test.ts,startup.test.ts}`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `dist/server.js`.

The build uses one ESM Node 20 bundle from src/index.ts; CJS dependencies use a createRequire(import.meta.url) shim, legal comments are retained at EOF. verify-build compares both file composition and exact bytes. No pretest rebuild hides stale artifacts. Tests use the MCP SDK and an owned stdio process, and terminate it with SIGTERM until EOF handling is addressed later.

TypeScript is only a development dependency for typechecking and explicit native integration tests. The bundled server is verified in a temporary directory without node_modules, with TSC_PATH set to that native binary. Runtime discovery never resolves TypeScript relative to this checkout: it follows a standard global tsc launcher on PATH or the explicit native TSC_PATH. MCP initialize/list works without a compiler; the first file tool reports an actionable PATH/TSC_PATH error. POSIX C probes exercise native version failures/timeouts; foreign launcher fixtures exercise discovery only. Process lifetime, URI safety and further tools remain later tasks.

## Original source SHA-256

These hashes are for raw pinned GitHub files, before transformations.

| File | SHA-256 |
| --- | --- |
| src/index.ts | a62c5f18f415c9076f1c76781af82e4d30855bca2f05959c1f261b0b3a34a7ba |
| src/lsp-client.ts | da03f28eec9dfe36848b3b0baa627b2327ba984472b7c7fe840bed8cab203f1a |
| src/pool.ts | 34ecbcca56cc35babde5dffe6a83a2ee0793cf181193c084d76273c9e6999f12 |
| src/resolve-binary.ts | 8279b610eabcb3079e68f430db00e3db0c0b6d6835f8b549b6c557f77454d4ca |
| test/sample.ts | 3b3aa53c152cae2418abd91147b52479001e2932e0fa732a78a9c404a7e834c7 |
| test/smoke.ts | 1f4c3e889a2db6fa760880b16f4521c700342b8a0a097be741b712c9202537c0 |
| package.json | 34fbb90a95bb011c425ed498d4ce1b740f4b0725c68bb96e1ca7db1aba335871 |
| README.md | ba908239eb44338b374acb48b1edddf9818d972037006564baebf6b2f03ed209 |
| tsconfig.json | 6d80a3e0abb1b9225e17bbacca296b41f8f218b1b8e2d457e37f764fdf7e66af |
| tsconfig.build.json | 6880b9ce8e5c58b7b8dbbab2d9877ea6f2e77c97d54c48c938767844f47d389c |
| .gitignore | 192a38fd0a4d4efd1a58226469bc252bc817919a8146a0aab7a0b353a6b78da1 |

## Original README.md

Historical upstream source; its installation/runtime claims do not describe the local package.

````markdown
# TS Hover MCP

**Give AI agents TypeScript type inference — no editor required.**

A standalone MCP server that provides type information using [TypeScript 7's native compiler](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). Works with any MCP client that supports stdio MCP servers.

No running editor or global compiler install is needed. It includes TypeScript 7 and manages native LSP instances directly, keeping them warm for fast subsequent queries.

## Install

Add an MCP server named `ts-hover`:

```json
{
  "mcpServers": {
    "ts-hover": {
      "command": "npx",
      "args": ["-y", "@zachsents/ts-mcp"],
      "cwd": "/tmp"
    }
  }
}
```

## How it works

1. Agent calls a tool (e.g. `hover` with a file path and position)
2. The MCP server finds the nearest `tsconfig.json` to determine the project root
3. It spawns (or reuses) a TypeScript 7 LSP instance for that project
4. Returns the type information
5. The TypeScript instance stays warm for 5 minutes, making follow-up queries near-instant

Multiple project roots are handled automatically — each gets its own TypeScript instance.

## Tools

### `hover`

Get TypeScript type information at a position, plus where it's defined. Returns the same info you'd see hovering in an IDE — resolved types, inferred types, JSDoc — and the definition location.

| Parameter   | Type     | Description                          |
| ----------- | -------- | ------------------------------------ |
| `file`      | `string` | Absolute path to the TypeScript file |
| `line`      | `number` | Line number (0-indexed)              |
| `character` | `number` | Character position (0-indexed)       |

### `diagnostics`

Get TypeScript errors and warnings for a file, along with available quick fixes and their exact text edits.

| Parameter | Type     | Description                          |
| --------- | -------- | ------------------------------------ |
| `file`    | `string` | Absolute path to the TypeScript file |

### `references`

Find all references to a symbol across the project.

| Parameter   | Type     | Description                          |
| ----------- | -------- | ------------------------------------ |
| `file`      | `string` | Absolute path to the TypeScript file |
| `line`      | `number` | Line number (0-indexed)              |
| `character` | `number` | Character position (0-indexed)       |

### `outline`

Get a structured outline of all symbols in a file — functions, classes, interfaces, types, variables — with line numbers and nesting.

| Parameter | Type     | Description                          |
| --------- | -------- | ------------------------------------ |
| `file`    | `string` | Absolute path to the TypeScript file |

### `rename`

Rename a symbol across the project. Applies the edits directly to all affected files.

| Parameter   | Type     | Description                          |
| ----------- | -------- | ------------------------------------ |
| `file`      | `string` | Absolute path to the TypeScript file |
| `line`      | `number` | Line number (0-indexed)              |
| `character` | `number` | Character position (0-indexed)       |
| `newName`   | `string` | The new name for the symbol          |

### `inlay_hints`

Get inferred type annotations for a line range — variable types, parameter types, return types that TypeScript infers but aren't written in code.

| Parameter   | Type     | Description                          |
| ----------- | -------- | ------------------------------------ |
| `file`      | `string` | Absolute path to the TypeScript file |
| `startLine` | `number` | Start line (0-indexed, inclusive)    |
| `endLine`   | `number` | End line (0-indexed, exclusive)      |

## Configuration

| Env var    | Description                                       |
| ---------- | ------------------------------------------------- |
| `TSC_PATH` | Override the path to the native TypeScript binary |

## License

MIT — Zach Sents
````

## Original tsconfig.json

Historical upstream source; its installation/runtime claims do not describe the local package.

````json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["bun"]
  },
  "include": ["src"],
  "exclude": ["extension", "node_modules"]
}
````

## Original tsconfig.build.json

Historical upstream source; its installation/runtime claims do not describe the local package.

````json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "NodeNext",
    "moduleDetection": "force",
    "moduleResolution": "NodeNext",
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": true,
    "rootDir": "./src",
    "outDir": "dist",
    "declaration": false,
    "sourceMap": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["bun"]
  },
  "include": ["src"],
  "exclude": ["extension", "node_modules"]
}
````
