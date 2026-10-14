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
| src/index.ts | src/index.ts | Six imported text formats retained; server metadata becomes typescript-native-lsp/1.1.0; add six JSON navigation/hierarchy tools, exact read-only/destructive annotations and MCP AbortSignal forwarding; forward a lazy cancellable compiler resolver; unify EOF, signals and transport errors through one cleanup promise. |
| src/lsp-client.ts | src/lsp-client.ts | Bun Timer type → ReturnType<typeof setTimeout>; bound native stdio lifetime/request cancellation; serialize backpressure-aware writes, validate framing/envelopes, drain bounded stderr, negotiate UTF-16 and reap only the owned child. Extract imported types into protocol.ts with strict Location/LocationLink, hierarchical/flat symbol and WorkspaceEdit parsers; capability checks; pull diagnostic resultId/cache; actual UTF-16 ranges; DocumentSession disk refresh, deletion/read-error handling and client-side watching; respond to ordered nested native configuration and real registrations/unregistrations. |
| src/pool.ts | src/pool.ts | Memoize lazy initialization before awaiting; lease and serialize whole operations per nearest tsconfig root, including both hover/definition siblings after a branch fails; composite hover/definition and diagnostics/fixes use one disk snapshot, quick fixes request the actual EOF range; track pending and retiring sessions, idle after 5 minutes, abort discovery/initialize and close owned sessions within the shutdown deadline. |
| src/resolve-binary.ts | src/resolve-binary.ts | Replace checkout-package resolution with global PATH/npm launcher discovery or absolute native TSC_PATH; canonicalize PATH and skip local .bin aliases; bound native package lookup to package-local or hoisted global sibling dependencies and reject canonical package/binary targets outside the global node_modules tree; reject wrappers; probe TypeScript 7+ directly with shell=false, bounded output and a 5 s timeout; AbortSignal immediately terminates and reaps its own pending version process. |
| test/sample.ts | test/sample.ts | Unmodified fixture. |
| test/smoke.ts | test/smoke.ts | Run with Node/tsx; explicit development native TSC_PATH; URL-based fixture path for Node 20; assertions/finally shutdown; await asynchronous resolution and pass a lazy callback; assert no error diagnostics and nonempty hints in the disposable sample copy. |
| package.json | package.json | Private local name/version, Node >=20; runtime SDK initially 1.27.1, updated to patched 1.32.1 under Task 4 controller scope ruling for GHSA-6qxp-vccf-f47h; Zod 4.3.6; Chokidar 4.0.3 / readdirp 4.1.2 and picomatch 4.0.7 (patched GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p); @types/picomatch 4.0.2 dev; TypeScript 7.0.2 moved to dev; esbuild 0.28.2, tsx 4.23.15, @types/node 20.19.43 exact; independent build/test scripts; remove Bun/oxlint/eslint/workspace/shx/publishing scripts. |
| README.md | README.md and snapshot below | Local README documents the packaged Codex runtime; verbatim original retained as historical source below. |
| tsconfig.json, tsconfig.build.json | tsconfig.json and snapshots below | Consolidated NodeNext strict noEmit config, ES2022 target, Node types; include src/test harness, exclude sample/fixtures; esbuild handles emit. |
| .gitignore | .gitignore | Ignore local node_modules and native test artifacts; bundled dist tracked. |

Task 4 adds `src/{files,documents,protocol,watchers}.ts`, `test/{files,documents,protocol,watchers}.test.ts`, and explicit development-only `test/task4-native-probe.ts`. Runtime watcher registrations accept exact/glob/RelativePattern strings and watch-kind masks, including readonly dependencies outside root. On macOS/Windows existing registered roots that are strict physical project ancestors use a live native recursive fs.watch handle to avoid eager broad-root crawling; project-local, external non-ancestor and missing-prefix registered roots, generic project events and Linux fallback use Chokidar with ready settlement and 100 ms metadata polling (including binary files) to observe atomic replacements and directory changes reliably without adding sleeps to requests. Polling adds periodic stat work to registered roots; generic source/config watching uses the same 100 ms polling after an observed event-driven bootstrap failure, still excluding .git/node_modules. Physical canonicalization selects the backend without changing matching/event paths. First ambiguous existing-file event (change or rename) conservatively emits Created and Changed, independently filtered by watch-kind; known files refine replacement to Changed. Only the affected directory subtree is scanned after directory events. Registered readonly watchers skip EACCES/EPERM and non-file special nodes; explicit document read failures still propagate. Nested native settings come from TypeScript 7.0.2 gitHead `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`, not assumed upstream preferences.

Task 4 review fixes root/drive-root separator pruning without watching whole disks in tests. A missing native callback conservatively emits Deleted for the callback path inside the registered static root even when its suffix does not match, always applying the Delete mask; known matching descendants are also deleted. This covers unopened descendants without crawling the ancestor at registration. A missing callback cannot distinguish a nonmatching file from a directory, so extra deletion invalidations are intentional. Native containment rejects parent/out-of-root callbacks. TypeScript 7.0.2 at the same pinned gitHead expands cached directory deletions through `internal/project/snapshotfs.go` (`expandAndFilterWatchEvents`, `collectFilesRecursive`). Development-only `test/task4-directory-native-probe.ts` suppresses all automatic watched-file notifications, establishes stale diagnostics after deletion, then proves a single directory Deleted produces TS2307 for an unopened dependency; an independent CLI confirms the error.

Task 5 adds `src/hierarchy.ts` and `test/{navigation,hierarchy,tools}.test.ts`. Definitions/implementations retain every result and full Location/LocationLink ranges (the normalized range uses targetSelectionRange when supplied, otherwise targetRange); legacy line/character and six MCP text formats stay compatible. Workspace symbols preserve cross-file locations and use workspaceSymbol/resolve only with advertised resolveProvider, forwarding opaque data. Call hierarchy stores original native items including data/tags under random UUIDs per client and semantic generation; incoming fromRanges belong to the caller, outgoing ranges to the source item. New node IDs support repeated traversal without accepting native items from callers. All MCP tools forward AbortSignal through pooled requests. A crash/restart creates an isolated hierarchy store. Traversal validates/reads its project-selector file and refreshes known documents without opening a new selector document; choosing another unchanged file in the same project retains valid IDs. Null and array responses both pass the post-response semantic-generation check before returning.

Task 6 adds `src/edits.ts` and `test/edits.test.ts`. Rename returns the complete native WorkspaceEdit; the pool validates and writes it within one operation lease. Only mutually exclusive changes or text-only documentChanges are supported; resource operations, annotations, stale/non-open versions, conflicting ranges, canonical duplicates, non-UTF-8 files and paths outside the real project or inside .git/node_modules are rejected before writing. UTF-16 offsets include the original BOM as sent to native; untouched bytes, CRLF and mode survive. Adjacent exclusive staging files use flush:true and injectable chmod, all snapshots are rechecked before replacement, and failures trigger snapshot-checked rollback plus cleanup and per-file error state. Observed external changes are preserved. This is not a cross-file filesystem atomicity or crash-durability guarantee, and arbitrary external writers do not participate in the pool lease. A narrow race remains between each last path/byte comparison and filesystem rename. After writes (including attempted rollback), hierarchy handles are invalidated and affected documents are synchronized/opened before releasing the lease, without waiting for polling events. MCP success text retains upstream meaning and empty names are rejected. The imported smoke now writes only to a disposable fixture copy and uses RenameResult. EditIO extends the planned filesystem Pick with chmod, so original mode is independent of umask and chmod failure remains injectable.

Task 6 review fix records the physical path alongside each synchronized document snapshot and exposes detached readonly URI/content/physical-path entries for rename validation. Sync resolves a path before reading that canonical target, keeping content and identity together. Preflight resolves every opened URI through EditIO and compares all snapshots mapped to each edited target. A retarget is rejected if either saved or current physical identity is edited; a retarget unrelated to every edit does not block rename. Deleted/inaccessible/unresolvable opened aliases fail closed before staging for nonempty edits. Numeric document versions remain strictly scoped to the native response URI; aliases never lend a version to a canonical URI. A changed physical identity uses the existing didChange path and increments the LSP version and semantic generation even if bytes are equal, invalidating stale hierarchy handles. No watcher backend or import graph changed.

Semantic generations reuse project/synchronized paths and native registration metadata while retaining every faithful filesystem notification/backend from Task 4. Ancestor catch-all noise is delivered without expiring hierarchy IDs; ancestor suffix matching file events, concrete external dependency registrations and known dependency ancestor deletions remain relevant. Unknown directory deletions admitted only by an ancestor-wide suffix are delivered to native but cannot establish semantic relevance without concrete or previously known dependency paths. Task 7 actual native acceptance found external named declarations covered only by an ancestor catch-all, so hierarchy preparation now supplements registration metadata with validated file identities from native workspace/symbol(''), cached per semantic generation. During that cached metadata phase, nonrecursive direct-parent directory listings of native-returned source paths also record existing regular source files and package/tsconfig/jsconfig JSON files. This covers re-export-only siblings omitted by the native symbol index without reading their contents, following symlink entries, traversing subdirectories or adding watcher roots; directory-read failures remain explicit. Unrelated logs, arbitrary JSON and independent child/sibling project directories stay outside this baseline. Source siblings in one concrete dependency directory may conservatively expire IDs. Native-returned identities seed existing watcher bookkeeping without opening dependency documents. Directory-observed siblings supply semantic relevance only: a post-registration listing cannot distinguish an existing file from a genuine creation with a delayed callback. Both categories' file changes and deleted ancestors expire IDs. Later native registrations inherit only currently existing native-known/opened paths (exact existence checks, no directory scan); directory siblings never become pre-event watcher evidence. A real 7.0.2 probe found a Created+Changed batch can leave a cached unknown source stale, including when split into immediate consecutive notifications. The original mask-filtered pair is now preserved, with event-triggered reconciliation for semantic-relevant delivered pairs only: the requested semantic read acts as a native barrier, an already-permitted Changed is replayed once, and that same pure native read is repeated at most once. Concurrent reads share the replay, retain their original total timeout/AbortSignal through both RPC and post-response watcher settlement, and return only verified results. Settlement cancellation releases the caller while existing watchers retain ownership of unfinished filesystem work and queued events; late completion is handled without restarting a native request or clearing pending replay state. Per-wait timers and abort listeners are removed on every outcome; first/repeat failure retains pending accounting. New ambiguous events during either read fail explicitly for a later retry, without an unbounded loop. No-event, Create-only and unrelated broad-event requests add no read. This does not repeat WorkspaceEdit filesystem application, initialization or arbitrary API calls, and adds no sleep. Unknown-file classification and masks remain unchanged. Events queued while metadata was in flight are reclassified before creating IDs. Post-read reconciliation settles watcher callbacks without draining those queues, preserving the metadata race check. Ordinary Changed events without pending ambiguity do not introduce a new retry error. User subset searches do not replace accumulated knowledge. This adds one native workspace-symbol query and one nonrecursive listing per distinct native-used source parent to the first hierarchy preparation per generation and requires workspaceSymbol capability; failures remain explicit. Native workspace symbols enumerate symbols across the session's project collection, not every program file: symbol-free or omitted dependency files outside these concrete immediate directories may remain unknown, and identities from previously indexed files are conservatively retained until session shutdown. This is a documented information boundary, not a complete dependency graph guarantee. No import-graph parser, extra watchers, broad ancestor crawl or per-tool metadata query was introduced.

Task 7 adds `test/native.test.ts`, `test/fixtures/project/`, `scripts/test-native.mjs`, and the Windows/Linux × Node 20/24 native CI matrix. Acceptance installs pinned TypeScript 7.0.2 into one temporary npm-global prefix outside the checkout, using separate empty user/global configs and a temporary npm cache. All tests reuse that prefix; the runner removes it in finally. The bundled MCP executes through the SDK with real native TypeScript; passive test-only child/wire recording captures owned PIDs, dynamic registrations, responses and stderr outside watched fixture projects. Exact cold references, navigation ranges, type/parameter hints, multi-file declaration rename with compiler verification, dependency/config freshness and process lifecycle have assertions. Test artifacts are ignored locally and uploaded on CI failure. EOF is checked on every platform; real SIGINT/SIGTERM on POSIX and separately named forceful parent termination on Windows reflect the platforms' actual signal behavior. Foreign matrix execution remains a release gate until the branch is pushed.

New local files: `.npmrc`, public `package-lock.json`, `scripts/{build-options,build,verify-build,test}.mjs`, `test/{support.ts,import.test.mjs,resolve-binary.test.ts,startup.test.ts,transport.test.ts,pool.test.ts,shutdown.test.ts}`, `test/fixtures/fake-lsp.mjs`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `dist/server.js`.

The build uses one ESM Node 20 bundle from src/index.ts; CJS dependencies use a createRequire(import.meta.url) shim, legal comments are retained at EOF. verify-build compares both file composition and exact bytes. No pretest rebuild hides stale artifacts. Tests use the MCP SDK and owned stdio processes; EOF and signal cleanup share the same pool shutdown path. Fake-LSP process injection is restricted to tests.

TypeScript is only a development dependency for typechecking and explicit native integration tests. The bundled server is verified in a temporary directory without node_modules, with TSC_PATH set to that native binary. Runtime discovery never resolves TypeScript relative to this checkout: it follows a standard global tsc launcher on PATH or the explicit native TSC_PATH. MCP initialize/list works without a compiler; the first file tool reports an actionable PATH/TSC_PATH error. POSIX C probes exercise native version failures/timeouts; foreign launcher fixtures exercise discovery only. LSP process lifetime/cancellation and pooled operation serialization are adapted locally. URI/document/protocol normalization and native settings/client-side watching are adapted in Task 4; Task 5 adds navigation and protected call hierarchy; real results for all tools remain Task 7 validation.

Task 8 adds portable `plugin.json` / `mcp.json`, the repository Codex marketplace and a discoverable TypeScript workflow skill, plus `scripts/codex-check.mjs` and independent package-contract tests. The installed-check script uses a separate temporary CODEX_HOME and actual plugin CLI/cache/AppServer activation; it never registers a direct MCP substitute. Optional `--keep-temp` retains owned installed files for further checks while still closing processes. Supplemental authenticated skill evaluation uses normal inherited login with session-only direct MCP / runtime skill roots from that cache; it is separate evidence, not proof of a combined authenticated marketplace model-turn flow. No auth copying, runtime installer or upstream synchronization is introduced. Claude's original native LSP configuration and unrelated plugin versions are preserved; only the TypeScript version becomes 1.1.0. The original `plugins/typescript-native-lsp/LICENSE` remains unchanged.

Pinned host compatibility: Codex CLI 0.162.1 rejects the published portable `extensions.com.openai.auth.type=none` property under an stdio `mcp.json` server (`unknown field extensions`), despite the public packaging guidance. Its stdio transport has no external authentication by default, so the shipped server declaration omits that property. The initial installed cache with the extension had zero MCP servers; an isolated diagnostic install with the field removed reported the installed plugin ID and all 12 tools. Final acceptance uses a fresh, unmodified installed cache. Recheck the parser when upgrading the host.

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
