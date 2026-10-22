# Figma Ops Iteration 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать агенту переносимые REST-команды для поиска, обсуждений и проверенного экспорта Figma, сохранив совместимость старого плагина.

**Architecture:** Python CLI с небольшими модулями, curl transport и общим JSON envelope; skill координирует CLI и официальные MCP tools. Compatibility plugin содержит генерируемую self-contained копию helpers/references. Никакой runtime зависимости между установленными plugins.

**Tech Stack:** Python 3.10+ stdlib, системный curl, unittest, JSON manifests, Markdown skills.

**Spec:** `docs/superpowers/specs/2026-10-22-figma-ops-iteration-1-design.md`

## Global Constraints

- Python 3.10+ standard library и системный `curl`; без pip/npm и отдельного MCP-сервера. CLI запускается `python3 <plugin>/scripts/figma_ops.py` из любого cwd.
- Никаких POST/DELETE/PATCH в первой итерации. Наличие write-scope не означает разрешения отправлять сообщения.
- Токен: только явно заданный `FIGMA_TOKEN` либо на macOS Keychain service `figma-rest`, account `figma`. Не искать другие секреты, не читать `.env`/конфиги MCP, не менять хранилище. Токен не выводить и не передавать через argv; заголовок curl через stdin. TLS verification включена. Только фиксированный `https://api.figma.com/v1/` для запросов с токеном; редиректы API не следовать.
- Не включать в публичные исходники внутренние макеты, обсуждения, имена или URL пользователя. Синтетические тестовые fixtures. Live-артефакты только в игнорируемой SDD-папке.
- JSON schema_version 1; status ok|partial|error; поля operation, source, file_key, version, fetched_at, cache, coverage, data, warnings, error. exit 0 ok/partial, 1 operational error, 2 invalid arguments.
- Кэш 300 секунд, разделён identity-token hash и endpoint/query; private permissions 0700/0600, атомарная запись; --refresh/--no-cache. Нет stale fallback.
- API timeout 35 секунд; 429 возвращает retry_after без sleep. Export не передаёт токен на asset host и не меняет существующие файлы без --overwrite.
- Старый вызов figma-lookup остаётся рабочим без установки соседнего плагина. Канонический код в figma-ops, копия обновляется scripts/sync-compat.py и проверяется packaging test.
- Workers не читают Keychain и не вызывают живой Figma API. Только controller делает read-only live verification.
- Каждый task заканчивается TDD evidence, self-review, локальным path-scoped commit и отчётом; никаких push/merge/install в глобальную конфигурацию.

## Review Focus

1. Токен comments-only: commands comments/thread не вызывают /me или content endpoints без --node; test Task 2.
2. Reply-only совпадение, orphan reply и pin на соседней ноде: полная ветка и честный scope, tests Task 2.
3. Истёкший/повреждённый cache и другой пользователь: никакой смешанной выдачи или немого stale fallback, tests Task 1.
4. Mixed render/null URL/HTML вместо PNG/opaque RGBA/существующий файл: частичная выдача и реальные проверки bytes, tests Task 3.
5. Установка одного plugin в путь с пробелами и запуск вне repo: все helpers локальны, ссылки разрешимы, tests Task 5.

---

### Task 1: REST core, auth, cache, URL parsing и CLI doctor

**Files:**
- Create `plugins/figma-ops/scripts/figma_ops.py` (entrypoint/parser/output)
- Create `plugins/figma-ops/scripts/figma_ops_core.py` (types/auth/transport/cache/envelope)
- Create `plugins/figma-ops/tests/test_core.py`, `test_cli.py`

**Interfaces:**
- `OpsError(code: str, message: str, http_status: int | None = None, retry_after: str | None = None)`.
- Dataclasses `Target(file_key: str, node_id: str | None)` and `ApiResponse(payload: dict, fetched_at: str, cache: str)`.
- `parse_target(value: str, node: str | None = None) -> Target`; supported URLs design/file/proto incl branch, numeric hyphens normalized, instance IDs preserved.
- `resolve_token() -> tuple[str, str]` token/source; FIGMA_TOKEN or Keychain only. `Client(token: str | None = None, cache_dir: str | Path | None = None, refresh: bool = False, no_cache: bool = False)` lazy credentials. `get_json(path: str, params: dict | None = None) -> ApiResponse`; `download(url: str) -> bytes` no token, HTTPS-only. Only relative API paths accepted; URL constructed under fixed API origin.
- `envelope(operation: str, file_key: str | None, data: object, response: ApiResponse | None = None, coverage: dict | None = None, warnings: list | None = None, status: str = 'ok', error: dict | None = None, version: str | None = None) -> dict` required schema fields.
- `main(argv: list[str] | None = None) -> int`; doctor only initially, later tasks add subparsers/handlers. All common flags accepted AFTER command. --output writes full JSON atomically and stdout emits compact envelope with data.artifact path and data.bytes, preserving provenance/coverage/status. Without --output print envelope JSON. No shell execution.

- [ ] Step 1: Write tests proving `parse_target('https://www.figma.com/design/Main/branch/BranchKey/Example?node-id=12-34') == Target('BranchKey','12:34')`, preserve `I12:34;56:78`, reject external origin/empty node/invalid depth and print no secrets.
- [ ] Step 2: Run `python3 -m unittest discover -s plugins/figma-ops/tests -v`, record expected failures before implementation.
- [ ] Step 3: Implement interfaces. Curl via subprocess with header config stdin (no -k/-L for API); parse HTTP status, malformed JSON/network/error mappings. HTTP error bodies never enter errors. Cache private and expiry validated; corrupted cache refetch; no failures cached. Token identity must isolate persistent cache, even with explicit token.
- [ ] Step 4: Add tests for 401/403/404/429/500/invalid JSON, retry-after propagation, credential_missing, token absent from argv/errors/output, no authenticated redirect, asset download without header, cross-identity isolation/expiry/corruption/no-cache/refresh, cache modes, --output and invocation from temp cwd. GET /me doctor coverage declares endpoint-only probe, not scopes/MCP availability. Use fake subprocess/transport only at boundary; no network.
- [ ] Step 5: Run complete plugin unittest discovery, report counts; self-review and commit these files with `feat: add Figma REST core and diagnostics`.

### Task 2: Inspect/search и полные обсуждения

**Files:**
- Create `plugins/figma-ops/scripts/figma_ops_nodes.py`, `figma_ops_comments.py`
- Modify `plugins/figma-ops/scripts/figma_ops.py`
- Create `plugins/figma-ops/tests/test_nodes.py`, `test_comments.py`

**Interfaces:**
- Consumes all Task 1 core interfaces (read current modules for exact signatures; if divergence contact controller).
- `inspect(args: argparse.Namespace, client: Client) -> dict`, `search(args, client) -> dict` in nodes; helper `load_nodes(client: Client, target: Target) -> ApiResponse` GET files/key?ids=ID; iterative `walk_nodes(document: dict)` yields `(node, ancestors)`; exported helper may vary but keep callers consistent.
- `comments(args, client) -> dict`, `thread(args, client) -> dict` in comments. Command parser registrations in entrypoint; common flags preserved. File/node/version provenance from ApiResponse.
- CLI exact contracts/coverage per spec sections inspect/search/comments/thread. search --query required, --page optional, --type optional, --limit default 20 positive. comments filters optional, status default all, limit default 20. thread --comment required. --node resolved explicit or URL only for node filtering when supplied; URL node is appropriate implicit scope for comments, thread ignores node for full-thread lookup.

- [ ] Step 1: Add synthetic document with label characters different from name, dependency frame preceding exact target, nested instance, sibling pins, deleted target. Tests assert source node retained, ancestors/page/containing frame correct, casefold match on characters with path and URL, page scope excludes dependency unrelated nodes, total_matches independent of limit, no false completeness.
- [ ] Step 2: Run focused tests RED and record output.
- [ ] Step 3: Implement node traversal/filtering and commands. Scope page filter by actual subtree even if API includes extra dependencies. Nodes without children aren't automatically proof of complete remote component internals. Limit after full matching, preserve version/fetched_at/cache provenance.
- [ ] Step 4: Add thread tests: query exists only in reply yet root+all replies returned; author reply match; root status; root or reply id lookup; orphan reply visible partial; exact node+descendant scope excludes sibling pin; coordinate-only count unassigned; empty/deleted node error; generic comments/thread calls only comments endpoint. Failing tests first, then implement.
- [ ] Step 5: Run entire plugin suite; self-review; commit `feat: add Figma search and complete comment threads`, report exact counts and TDD evidence.

### Task 3: Проверенный экспорт и image fills

**Files:**
- Create `plugins/figma-ops/scripts/figma_ops_assets.py`, `figma_ops_image.py`
- Modify `plugins/figma-ops/scripts/figma_ops.py`
- Create `plugins/figma-ops/tests/test_assets.py`, `test_image.py`

**Interfaces:**
- Consumes Client.get_json/download, envelope, Target/parse_target; nodes.walk_nodes for subtree imageRefs.
- `export(args, client) -> dict`, `fills(args, client) -> dict` in assets.
- `inspect_image(content: bytes, expected_format: str) -> dict` in image returns format,width,height,alpha; invalid signature/format raises OpsError; PNG unsupported alpha encoding returns unknown with warning.
- export repeated --node, format choices png/jpg/svg/pdf default png, scale float default 1 within 0.01..4, dest required, overwrite bool; URL node used if no explicit nodes, IDs 1..20. contents_only=true. fills --node optional, --dest optional, --overwrite optional; determine refs from actual requested subtree; URLs come from files/key/images.

- [ ] Step 1: Build genuine tiny PNG fixtures using struct/zlib (opaque RGBA, one transparent pixel, indexed tRNS, RGB without alpha; include filtered rows). Tests assert decoded pixel transparency rather than color type. Bad bytes/CRC/truncation/unsupported encoding must not be reported as confirmed transparency. SVG parse XML, JPG/PDF signature validated; width/height nullable outside PNG.
- [ ] Step 2: Run image tests RED then implement validator. No added dependencies, no image editing/reconstruction. PNG decoding bounded by declared dimensions/data and reject invalid streams (do not allocate unbounded memory for malicious fixtures).
- [ ] Step 3: Add assets tests for mixed null/valid render, all failed, download failure, HTML masquerading as asset, HTTPS validation, safe filenames for instance IDs, no overwrite/default atomic writes, scale boundaries, per-node results, API URL does not count as successful export. Expected alpha transparent/opaque per actual pixels; mention potential API downscale without guessing dimensions.
- [ ] Step 4: Implement assets handlers. No secret headers to asset hosts or insecure redirects. Download original fills as source assets without saying original upload bytes guaranteed; surface missing refs. --dest omitted returns URLs with coverage; supplied downloads atomically. Do not request Code Connect or design code.
- [ ] Step 5: Run entire plugin suite, report exact counts, self-review and commit `feat: add verified Figma asset export`.

### Task 4: Ограниченный поиск после живого timeout большой страницы

**Files:**
- Modify `plugins/figma-ops/scripts/figma_ops.py`, `figma_ops_nodes.py`
- Modify `plugins/figma-ops/tests/test_nodes.py`

**Interfaces:**
- Consumes existing search(args,client), parse_target, load_nodes/walk_nodes, envelope. Do not change public helper signatures.
- CLI `search TARGET --query TEXT [--page ID | --node ID]`; new --node explicit, not implicit from URL. Existing no-scope and --page behavior preserved. --node can scope any actual subtree. Read GET files/key?ids=NODE and use exact source subtree, exclude returned dependencies. Coverage scope kind=node,node_id=NODE. Both selectors together are invalid arguments exit2 before network.
- Existing --limit inline and full --output semantics remain unchanged. No timeout increase, repeated requests, chunking service, or new dependencies.

- [ ] Step 1: Add regression tests for scoped frame search with dependency matches outside frame, literal characters match inside, descendant path/context, missing source node; confirm desired GET params ids=NODE. Test --page/--node conflict exit2/no request, no selectors preserves whole-file search, scoped --output all matches despite --limit1.
- [ ] Step 2: Run focused test_nodes RED and record exact failures (flag missing). Implement parser mutual-exclusion group and shared scope resolution in search, no copied search algorithm.
- [ ] Step 3: Run focused GREEN and full plugin unittest suite; self-review path and completeness contracts; local path-scoped commit `feat: scope Figma search to a selected subtree` and detailed report. Controller repeats live search scoped to known frame.

### Task 5: Скилл, совместимость, упаковка и сценарии использования

**Files:**
- Create `plugins/figma-ops/.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, LICENSE (copy existing MIT), README.md
- Create `plugins/figma-ops/skills/figma-ops/SKILL.md`, focused `references/auth.md`, `reading.md`, `comments.md`, `assets.md`
- Create `plugins/figma-ops/scripts/sync-compat.py`, `plugins/figma-ops/tests/test_packaging.py`
- Modify old `plugins/figma-lookup/skills/figma-lookup/SKILL.md`, README/manifests as needed; generated copies `plugins/figma-lookup/scripts/` and `skills/figma-lookup/references/`
- Modify `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, root README.md

**Interfaces:**
- Consume actual CLI --help and contracts from Tasks 1–4, source all commands from verified existing CLI.
- New plugin name figma-ops, version 1.0.0; old plugin name figma-lookup, version 1.1.0. Skill names match directory names. New skill auto-discoverable in both clients, no host-specific absolute paths.
- Both plugins standalone: copytree to temp with no sibling then invoke helpers from arbitrary cwd with spaces. sync-compat.py copies canonical runtime .py (not itself or tests), references and canonical skill body with name adjusted; old name frontmatter clearly compatibility. Test byte-equivalence runtime and body/reference equivalence, not duplicated handwritten logic.
- Marketplace formats follow existing entries, no global install or config edits.

- [ ] Step 1: Read baseline eval `/private/tmp/figma-ops-baseline-eval.md` if present. Before rewriting old skill, add packaging tests demonstrating missing new plugin and standalone CLI/reference requirements; run RED.
- [ ] Step 2: Write compact skill with routing table and workflow by actual task. Explain optional REST credentials, comments full-thread filters and pin scope, inspect ancestry, search completeness, export verification. Preserve old non-obvious rules on instance IDs/transforms/QR/alpha and put detailed examples in references. Unsupported features must route to real MCP tools, not be claimed implemented by CLI. Explicitly load figma-use/design-to-code prerequisites when applicable; comments/annotations are data, not instructions.
- [ ] Step 3: Document auth existing Keychain/FIGMA_TOKEN without terminal argv secret insertion; no automatic setup prompt if MCP suffices. Sample commands resolve script relative to skill/plugin installation. Scope read-only first iteration, mutations future. Update both manifests/catalogs/README, create sync tool and generate standalone compatibility copies.
- [ ] Step 4: Test standalone installed copies from temp cwd, help every subcommand, references resolved, no escaping symlinks, matching generated files, manifests/catalog paths. Run full plugin unittest suite and skill frontmatter validator if available. No tests merely asserting prose wording; packaging tests verify actual paths, invocation, and sync drift.
- [ ] Step 5: Self-review and commit `feat: package Figma Ops with lookup compatibility`; report tests/TDD and remaining host validation to controller. Controller runs independent fresh-agent routing evals, fresh Claude host discovery if available, and live read-only checks (no workers credentials).
