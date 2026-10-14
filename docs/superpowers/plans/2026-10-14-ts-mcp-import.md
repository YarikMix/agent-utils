# Импорт ts-mcp и поддержка Codex — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Импортировать ts-mcp, исправить подтверждённые дефекты, выпустить `typescript-native-lsp` для Codex и переименовать репозиторий в `YarikMix/agent-plugins`.

**Architecture:** Четыре файла реализации upstream остаются основой MCP-сервера и пула LSP по ближайшему tsconfig. Из большого LSP-клиента выделяются обработка документов, проверка ответов, файловые операции и хранение call hierarchy; готовый ESM-бандл и скилл устанавливаются отдельным Codex-пакетом. Claude Code сохраняет прямое подключение LSP.

**Tech Stack:** Node.js 20+, TypeScript 7, MCP SDK, Zod, esbuild, `node:test` с tsx; реальные проверки TypeScript и Codex App Server; GitHub Actions на Linux/Windows.

**Spec:** [Согласованная спецификация](../specs/2026-10-14-ts-mcp-import-design.md). Исполнитель читает и план, и спеку; итоговое ревью сверяется со спекой.

## Global Constraints

- База: `eed751aca38991ab547a314a4401ce84fe54e0cf`. Worktree: `/Users/y.mihalev/projects/agent-plugins-codex-typescript-native-lsp`, ветка `codex-typescript-native-lsp`; повторно не создавать.
- Импорт: `zachsents/zachs-tools`, SHA `039e5f38503eb5ace3a82a4a55fb6d5e7dce3ce1`, `packages/ts-mcp`, версия `0.3.7`. Никаких плавающих исходников, форка, подмодуля или автоматической синхронизации.
- Все пути `P/` ниже означают `plugins/typescript-native-lsp/codex/`. Собственный npm-пакет `typescript-native-lsp-codex`, `private: true`, версия `1.1.0`, Node `>=20`; публичный lock-файл. Без Bun и `workspace:*`.
- MIT с `Copyright (c) Zach Sents`, без выдуманного года; `UPSTREAM.md` и notices. Существующий `plugins/typescript-native-lsp/LICENSE` не заменять.
- Runtime: только установленный глобальный TS 7+ из PATH или `TSC_PATH` на нативный бинарник. Никаких скачиваний при запуске, зависимости от node_modules чекаута, TS6, fallback tsserver или автоподбора локального TypeScript.
- Lazy запуск; проверка версии **5 с**, initialize/request **30 с**, shutdown **2 с**, idle **5 минут**. stdout — только MCP, bounded stderr logging; управлять только собственными процессами.
- Ровно 12 инструментов: `hover`, `diagnostics`, `references`, `outline`, `rename`, `inlay_hints`, `definition`, `workspace_symbols`, `implementations`, `prepare_call_hierarchy`, `incoming_calls`, `outgoing_calls`. Сохранять upstream аргументы шести инструментов; позиции с **0**, UTF-16.
- `references` использует `includeDeclaration: true`; `rename` — запись только по явной просьбе. Остальные инструменты read-only; quick fixes возвращаются как данные. Ошибка не превращается в успешный пустой ответ.
- Codex: `plugin.json`, `mcp.json`, настоящий каталог skills; сервер `typescript_native_lsp`, `type: stdio`, `command: node`, `args: ["./dist/server.js"]`, `cwd: "./"`.
- Каталог Codex: `yarikmix-plugins`, единственный source `./plugins/typescript-native-lsp/codex`. В каталоге Claude сохраняются все три записи, версии прочих плагинов и прежний TS LSP command/args/extensionToLanguage; версия TS — `1.1.0`.
- Неоткрытая зависимость может обновляться асинхронно до **2 с**; без постоянной задержки каждого запроса. macOS проверяется реально; Windows/Linux — реальным CI. Непроведённые проверки не объявлять успешными.
- Исторические документы не переписывать; прочие плагины не портировать. Не публиковать npm-пакет, upstream PR или заявку в универсальный каталог OpenAI.
- Каждая задача завершается проверкой и path-scoped коммитом своих файлов. При subagent-driven исполнении — один исполнитель за раз: задачи меняют общие `index.ts`, `lsp-client.ts`, `pool.ts`; ревью каждой задачи до следующей. Локальную установку, авторизованную переименовку GitHub и выпуск ведёт контроллер.

## Review Focus

1. Пробелы, кириллица, `#`, `%`, Windows drive paths и UTF-16 после emoji: реальные пути и точные позиции; rename сохраняет BOM/CRLF. Проверки: задачи 4, 6.
2. Два холодных запроса, удаление открытого импорта и изменение неоткрытой зависимости: одна сессия, TS2307, новая версия без смешивания ответов. Проверки: задачи 3, 4, 7.
3. Зависший/падающий LSP, отмена, EOF во время initialize: нет утечек процессов и присвоения позднего ответа другому запросу. Проверки: задачи 3, 7.
4. Повреждённый WorkspaceEdit, внешняя symlink-цель, конфликт правок/версий или ошибка записи второго файла: до валидации ничего не записано, частичная запись сообщается ошибкой. Проверки: задача 6.
5. Поддельный, чужой и устаревший hierarchy item_id, а также кэш установки без node_modules: корректный отказ идентификатора и работа всех инструментов из установленного пакета. Проверки: задачи 5, 8, 9.

---

## Карта файлов и общий тестовый контракт

| Файлы | Ответственность |
|---|---|
| `P/src/index.ts`, `P/src/pool.ts` | Импортированный MCP API, orchestration/завершение; выбор проекта, сериализация операций и lifetime клиентов |
| `P/src/lsp-client.ts`, `P/src/resolve-binary.ts` | Импортированный transport, запросы LSP и запуск native TS; разрешение глобальной установки |
| `P/src/protocol.ts` | Выделенные upstream типы/парсеры, нормализация и проверка ответов/capabilities |
| `P/src/files.ts`, `P/src/documents.ts` | URI/UTF-16/границы записи; содержимое/версии документов, очередь файловых событий |
| `P/src/edits.ts`, `P/src/hierarchy.ts` | Подготовка/применение WorkspaceEdit; opaque идентификаторы с исходным LSP data |
| `P/test/support.ts`, `P/test/fixtures/fake-lsp.mjs` | Временные проекты, управляемый LSP с Content-Length, запись отправленных сообщений/собственных PID |
| `P/test/sample.ts`, `P/test/smoke.ts`, `P/test/import.test.mjs`, `P/test/*.test.ts` | Сохранённые upstream fixture/smoke с assertions; регрессионные, протокольные и реальные тесты |
| `P/package.json`, `P/package-lock.json`, `P/tsconfig.json`, `P/.npmrc`, `P/.gitignore`, `P/scripts/{build-options,build,verify-build,test}.mjs`, `P/dist/server.js` | Самостоятельная сборка, публичные зависимости, воспроизводимый артефакт |
| `P/{LICENSE,THIRD_PARTY_NOTICES.md,UPSTREAM.md,README.md,plugin.json,mcp.json}`, `P/skills/typescript-native-lsp/SKILL.md` | Происхождение, runtime-контракт, манифесты и workflow Codex |
| `.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json`, README четырёх уровней, `.github/workflows/typescript-native-lsp.yml` | Каталоги, совместимость, адрес репозитория и CI |

Все команды `npm` в задачах 1–8 выполняются из `P/`, с явным публичным registry; для локальных install-проб использовать разные пустые temporary user/global npm config, не выводить пользовательские настройки. `npm test -- test/name.test.ts` передаёт выбранные файлы в `node --import tsx --test`; полный `npm test` запускает import/protocol/unit tests без native suite и без fixture исходников. Для этого `scripts/test.mjs` выбирает `test/*.test.ts` (кроме native.test.ts) и import.test.mjs либо использует переданные argv, затем spawn Node с shell=false. `npm run test:live` запускает только `test/native.test.ts`; `npm run test:codex -- --marketplace <root-or-url> [--ref <ref>]` — отдельную установленную копию. Не добавлять `pretest`, который незаметно перезапишет dist до его проверки. Обновлять `UPSTREAM.md`/notice при изменениях импорта и библиотек; окончательно пересобрать dist в задаче 8.

### Task 1: Самостоятельный импорт с проверяемой сборкой

**Files:** Create `P/src/{index,lsp-client,pool,resolve-binary}.ts`, `P/test/{sample,smoke,support}.ts`, `P/test/import.test.mjs`, `P/scripts/test.mjs`, package/build/license файлы из карты. Из upstream перенести README и обе tsconfig как исходный материал, свести сборку к `P/tsconfig.json`, все преобразования перечислить в `UPSTREAM.md`.

**Interfaces:** Сохранить upstream `LspClient`, `TypeScriptPool` и экспортируемые `LspLocation/LspDiagnostic/LspTextEdit/LspCodeAction/LspSymbol/LspInlayHint`. `buildOptions(outdir: string): BuildOptions` выдаёт один ESM `server.js` из `src/index.ts`, bundle=true, platform=node, target=node20, legalComments=eof; для CJS-зависимостей — require shim через createRequire(import.meta.url), как в apple-notes-folder. `verify-build` сравнивает состав и байты dist с временной сборкой. В support: `openMcp(entryPath: string, env?: NodeJS.ProcessEnv): Promise<{ client: Client; process: ChildProcessWithoutNullStreams; close(): Promise<void> }>` через MCP SDK; `temporaryProject(files: Record<string, string>): Promise<{ root: string; dispose(): Promise<void> }>` создаёт fixture. В последующих задачах расширять эти helpers, не создавать конкурирующий transport.

- [ ] **1. Написать `import.test.mjs` и assertions smoke.** В начале теста читать/assert целевые метаданные через built-in fs/assert, затем динамически импортировать support.ts; RED не требует tsx или SDK до появления пакета. Проверять метаданные/происхождение, standalone tool discovery и базовое обращение к TS7; опубликованный пакет — только контроль из предыдущей пробы, не источник кода.

```ts
assert.equal(pkg.private, true); assert.equal(pkg.name, 'typescript-native-lsp-codex');
assert.equal(pkg.engines.node, '>=20'); assert.equal(pkg.version, '1.1.0');
assert.match(upstream, /039e5f38503eb5ace3a82a4a55fb6d5e7dce3ce1/);
assert.match(license, /Copyright \(c\) Zach Sents/);
assert.deepEqual(tools.map(t => t.name).sort(), ['diagnostics','hover','inlay_hints','outline','references','rename']);
assert.match(hoverText, /number/); // fixture из upstream, известная позиция
```

- [ ] **2. RED:** `node --test test/import.test.mjs`. Ожидается падение по отсутствующим целевым метаданным/бандлу, не по отсутствующему runner. Сохранить имя assertion и вывод.
- [ ] **3. Перенести только файлы зафиксированного пакета.** MCP SDK `1.27.1`, Zod `4.3.6` — runtime; TypeScript `7.0.2`, esbuild `0.28.2`, `tsx@4`, `@types/node@20` — dev. Последние две patch-версии разрешить публичным npm и сохранить exact вместе с lock. Scripts: build/verify-build/typecheck/test/smoke; test:live и test:codex добавляются со своими runners в задачах 7/8. Typecheck включает src и test harness, исключает намеренно некорректные fixture исходники. Заменить Bun `Timer` на `ReturnType<typeof setTimeout>`; убрать oxlint/workspace/shx/монорепозиторные scripts. Исходную реализацию на этом этапе не заменять. MIT/notice фиксируют автора и библиотеки; собственный README описывает текущую импортированную базу.
- [ ] **4. GREEN:** `npm ci`, `npm run typecheck`, `npm run build`, `npm test -- test/import.test.mjs`, `npm run smoke`, `npm run verify-build`. В smoke/import явно передать dev-native `TSC_PATH`. Ожидается 6 tools, непустой hover и побайтное совпадение одного server.js; no `workspace:*`/внутренних registry в собственных package/lock. Проверить запуск bundle из temp-копии без node_modules, с явным native TSC_PATH; до исправления EOF завершать тестовый child через SIGTERM в finally.
- [ ] **5. Коммит:** `git add` только созданные файлы задачи в `P/`; `git commit -m "feat: vendor pinned ts-mcp as standalone Codex package"`. Обнаруженные URI/delete/EOF регрессии пока не объявлять исправленными.

### Task 2: Глобальный native TS7 и lazy запуск

**Files:** Modify `P/src/resolve-binary.ts`, `P/src/pool.ts`, `P/src/index.ts`, `P/test/support.ts`; Create `P/test/resolve-binary.test.ts`, `P/test/startup.test.ts`.

**Interfaces:** `resolveTscBinary(options?: ResolveOptions): Promise<string>`, где `ResolveOptions = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; versionTimeoutMs?: number }` — тестовая инъекция, default env/process, timeout=5000. `TypeScriptPool` принимает `resolveBinary: () => Promise<string>` вместо готового пути; `index.ts` передаёт callback, не вызывает resolver при создании MCP.

- [ ] **1. Написать проверки discovery без компилятора, POSIX symlink и Windows npm shim; TSC_PATH, TS6, неверной версии, missing binary, зависшего --version и PATH с пробелами.** На каждой ОС проверять свой реальный launcher; чужую ОС — разбор fixture, не выдуманный native запуск. `startup.test.ts` строит пакет и запускает MCP с PATH без tsc.

```ts
assert.equal(spawnCountBeforeFirstTool, 0);
assert.equal(handshake.ok && tools.length === 6, true);
await assert.rejects(resolveTscBinary(ts6Options), /TypeScript.*7/);
await assert.rejects(resolveTscBinary(hungOptions), /version.*timed out/i);
assert.equal(resolvedPath, expectedNativePath); assert.equal(versionProbe.shell, false);
```

- [ ] **2. RED:** `npm test -- test/resolve-binary.test.ts test/startup.test.ts`; импортированная база eagerly разрешает зависимость пакета и не проверяет версию/глобальный launcher.
- [ ] **3. Реализовать resolver и lazy callback.** `TSC_PATH` обязан указывать на существующий исполняемый native binary; относительный путь отвергать. Для PATH найти стандартный tsc executable/shim, разрешить symlink или npm shim к `typescript/bin/tsc`, затем через package-relative resolution найти `@typescript/typescript-${platform}-${arch}/lib/tsc(.exe)`. Не исполнять/не eval содержимое shim, shell=false. Проверить version 7+ за 5000 ms, остановить собственную пробу при timeout, дать actionable error с PATH/TSC_PATH. Обновить startup test count в задаче 5 после добавления tools.
- [ ] **4. GREEN:** выбранные тесты + `npm run typecheck`; реальная проба глобального `tsc` и explicit native TSC_PATH возвращают одинаковый binary. MCP без компилятора отвечает initialize/list, первый file tool выдаёт понятную ошибку. Постоянные настройки пользователя не менять.
- [ ] **5. Коммит:** собственные files задачи и provenance; `git commit -m "fix: resolve global native TypeScript lazily"`.

### Task 3: Lifetime LSP, отмена, пул и EOF

**Files:** Modify `P/src/{lsp-client,pool,index}.ts`; Create `P/test/{transport,pool,shutdown}.test.ts`, `P/test/fixtures/fake-lsp.mjs`; Extend `P/test/support.ts`.

**Interfaces:** `RequestOptions = { signal?: AbortSignal; timeoutMs?: number }`. `LspClient.create(binaryPath: string, rootUri: string, options?: ClientOptions): Promise<LspClient>`; `ClientOptions = { spawnProcess?: (binaryPath: string, projectRoot: string) => ChildProcessWithoutNullStreams; requestTimeoutMs?: number; shutdownTimeoutMs?: number }` — тестовая инъекция; runtime=30000/2000 ms. Добавить необязательный последний `RequestOptions` всем operation methods; private `sendRequest(method: string, params: unknown, options?: RequestOptions): Promise<unknown>`.

`TypeScriptPool.withClient<T>(filePath: string, operation: (client: LspClient) => Promise<T>): Promise<T>` выбирает корень, memoizes initialization, держит lease и сериализует operation по корню; wrappers upstream используют его. Constructor options: `{ idleTimeoutMs?: number; createClient?: (binaryPath: string, rootUri: string) => Promise<LspClient> }`, default idle=300000. `shutdown(): Promise<void>` у обоих объектов — идемпотентный.

- [ ] **1. Написать протокольные проверки split/coalesced Content-Length и Unicode byte lengths, error/spawn failure, timeout/cancel/late response, шумного stderr; конкурентный cold start, nested/no tsconfig, isolation и idle с активным lease.** Shutdown проверять и до завершения initialize, и при двух сессиях; unrelated TS-like процесс оставить живым.

```ts
assert.equal(createdForSameRoot, 1); assert.equal(createdForDifferentRoots, 2);
assert.equal(defaultIdleTimeoutMs, 300000);
assert.equal(cancelMessage.method, '$/cancelRequest'); assert.equal(cancelMessage.params.id, cancelledId);
assert.equal(secondResult, 'second'); // поздний ответ первого не принят
assert.equal(remainingOwnedPids.length, 0); assert.equal(unrelatedProcessAlive, true);
assert.ok(shutdownDurationMs <= 2250); // 2000 ms deadline + 250 ms допуск планировщика теста
```

- [ ] **2. RED:** `npm test -- test/transport.test.ts test/pool.test.ts test/shutdown.test.ts`; сохранить воспроизведение duplicate start, request cancellation и EOF на импортированной базе.
- [ ] **3. Исправить transport/pool/cleanup.** Native spawn с cwd=fileURLToPath(rootUri), корректным rootUri и `--lsp --stdio`; только LSP initialize/initialized, без ожидания событий готовности tsserver. Дедуп promise создать до await, учитывать pending clients в shutdown и не сохранять client после закрытия пула. У crash/init failure отвергнуть pending requests и закрыть child; следующий вызов может открыть новую сессию. Таймаут/AbortSignal удаляют pending и посылают cancel; учитывать backpressure, malformed JSON/protocol errors и потреблять stderr с ограничением повторов. Lease не даёт idle таймеру закрыть активную операцию. EOF end/close, SIGINT/SIGTERM/ошибки transport используют одну cleanup promise; shutdown/exit завершают собственный native процесс до 2 с, очищают timers и queues.
- [ ] **4. GREEN:** выбранные тесты и typecheck. Реальный stdin EOF через SDK transport отдельно проверяется в задаче 7; никаких killall/pkill по имени.
- [ ] **5. Коммит:** файлы задачи и provenance; `git commit -m "fix: bound LSP lifecycle and serialize project operations"`.

### Task 4: URI, синхронизация документов и честные ответы

**Files:** Create `P/src/{files,documents,protocol}.ts`, `P/test/{files,documents,protocol}.test.ts`; Modify `P/src/{lsp-client,pool,index}.ts`, package/lock/notices.

**Interfaces:** В `protocol.ts` выделить и реэкспортировать через `lsp-client.ts` upstream типы. Добавить `Position = { line: number; character: number }`, `Range = { start: Position; end: Position }`, `parseLocations(value: unknown): LspLocation[]`, `parseSymbols(value: unknown, file: string): LspSymbol[]` и `requireCapability(method: string, capabilities: Record<string, unknown>): void`.

`files.ts`: `pathToUri(file: string): string`, `uriToPath(uri: string): string`, `positionToOffset(text: string, position: Position): number`, `assertProjectWritePath(root: string, file: string): Promise<string>` (возвращает realpath). `documents.ts`: `DocumentSession(root: string, notify: (method: string, params: unknown) => void)`; `sync(file: string): Promise<string>` возвращает свежий текст, `flushFileEvents(): Promise<void>`, `getVersion(uri: string): number | undefined`, `close(): Promise<void>`, readonly `generation: number`. `LspClient` предоставляет readonly `projectRoot: string` и `documentSession: DocumentSession` для leased операции rename в задаче 6. Transport поддерживает `workspace/configuration` и объявленные server registrations; configuration содержит реальные inlay preferences, а не только пустое подтверждение.

- [ ] **1. Написать URI/UTF-16 и протокольные тесты.** `Location`/`LocationLink`, single/array/null; nested `DocumentSymbol` и flat `SymbolInformation`; обе формы `textDocumentSync`; pull diagnostics full/unchanged с resultId/cache. Ошибочная форма ответа или отсутствующая capability — ошибка инструмента. Позиции -1, дробные, вне строки/файла — отказ; endLine inlay exclusive, диапазон до EOF допустим без несуществующей позиции. Проверить отсутствие циклов/смешивания одинаковых имён в symbol tree.

```ts
assert.equal(uriToPath(pathToUri(specialPath)), specialPath); // пробел, кириллица, #, %; drive path на Windows
assert.equal(positionToOffset('😀x\r\n', {line: 0, character: 2}), 2);
assert.throws(() => positionToOffset('x', {line: 0, character: 2}), /position/i);
assert.equal(allDefinitions.length, 2); assert.deepEqual(nestedSymbols[0].children.map(s => s.name), ['run']);
assert.equal(malformedDiagnosticResult.isError, true); assert.equal(missingFileResult.isError, true);
```

- [ ] **2. Написать document regression tests:** открыть import, удалить его, затем запросить импортирующий файл; читать ENOENT как удаление, EACCES как ошибку. Параллельные requests после внешней правки должны иметь строго возрастающие версии и один порядок sync→request. Файловые события для create/delete/tsconfig отправляются до операции.

```ts
assert.ok(messages.some(m => m.method === 'textDocument/didClose' && m.params.textDocument.uri === deletedUri));
assert.equal(session.getVersion(deletedUri), undefined);
assert.ok(messages.some(m => m.method === 'workspace/didChangeWatchedFiles' && m.params.changes.some(c => c.type === 3)));
assert.deepEqual(changedVersions, [2, 3]); assert.ok(eventIndex < queryIndex);
```

- [ ] **3. RED:** `npm test -- test/files.test.ts test/documents.test.ts test/protocol.test.ts`; отдельно сохранить дефекты URI и delete на импортированной базе (не считать отсутствие выделенного модуля воспроизведением прежнего бага).
- [ ] **4. Реализовать модули и подключить их к импортированным methods.** URI — Node pathToFileURL/fileURLToPath; reject non-file URI и относительный input file. `sync` перечитывает открытые документы, didClose+delete-map+delete-event на ENOENT, не проглатывает прочие read errors; full или incremental didChange по negotiated sync. Изменения и события повышают generation. Для очереди событий проекта использовать bundled `chokidar@4.0.3` (добавить notice): source/config changes внутри root, исключить `.git`, node_modules обслуживает native watcher. Обработать server watched-file registrations, configuration и unregister; закрыть watcher при shutdown. Выполнять flush/sync внутри lease задачи 3; hover+definition получают один согласованный snapshot. Корректно парсить null/empty и ошибочные формы, сохранять diagnostic resultId/cache, давать MCP isError при protocol/capability/read failure. Заменить quick-fix range с 1_000_000 на реальный EOF, правки только возвращать.
- [ ] **5. GREEN:** выбранные тесты, typecheck и реальная короткая проба удаления открытого import: diagnostics содержит TS2307, как независимый TS7. Без sleep на каждой операции; bounded polling изменения неоткрытой зависимости — задача 7.
- [ ] **6. Коммит:** новые/изменённые файлы задачи и provenance; `git commit -m "fix: synchronize LSP documents and normalize protocol data"`.

### Task 5: Шесть новых инструментов и защищённая call hierarchy

**Files:** Create `P/src/hierarchy.ts`, `P/test/{navigation,hierarchy,tools}.test.ts`; Modify `P/src/{index,lsp-client,pool,protocol}.ts`, `P/test/{import,startup}.test.ts`.

**Interfaces:** `WorkspaceSymbol = { name: string; kind: string; file: string; line: number; character: number }`; `HierarchyNode = { item_id: string; name: string; kind: number; file: string; range: Range; selectionRange: Range; detail?: string }`; `CallEdge = { item: HierarchyNode; fromFile: string; fromRanges: Range[] }`. В `hierarchy.ts` определить `CallHierarchyItem` с обязательными стандартными полями и непрозрачным `data?: unknown`; `HierarchyStore` привязан к client/session: `put(item: CallHierarchyItem, generation: number): HierarchyNode`, `get(itemId: string, generation: number): CallHierarchyItem`, `clear(): void`.

У `LspClient` и wrappers пула: `definition(file, line, character, options?): Promise<LspLocation[]>` (у клиента уже есть); `workspaceSymbols(file: string, query: string, options?): Promise<WorkspaceSymbol[]>`; `implementations(file, line, character, options?): Promise<LspLocation[]>`; `prepareCallHierarchy(file, line, character, options?): Promise<HierarchyNode[]>`; `incomingCalls(file: string, itemId: string, options?): Promise<CallEdge[]>`; `outgoingCalls` — та же сигнатура. Здесь file:string, line/character:number, options:RequestOptions. MCP args используют `item_id`; новые ответы — JSON text с этими объектами и всеми диапазонами. Старые шесть сохраняют существующий text format.

- [ ] **1. Написать проверки точного discovery/annotations и методов LSP, множественных definitions, workspace symbols разных файлов, implementations и обхода обоих направлений.** Fake server возвращает item с data и повторяющимися именами. Incoming fromRanges относятся к caller (`fromFile`), outgoing — к исходному item; новые nodes получают дальнейшие id. Тестировать unsupported capability и частично повреждённые results.

```ts
assert.equal(tools.length, 12); assert.deepEqual(tools.map(t => t.name).sort(), expectedToolNames.sort());
assert.equal(tools.find(t => t.name === 'rename').annotations.readOnlyHint, false);
assert.ok(tools.filter(t => t.name !== 'rename').every(t => t.annotations.readOnlyHint === true));
assert.deepEqual(sentIncomingItem.data, opaqueUpstreamData);
assert.deepEqual(definitionPaths, [firstDefinitionPath, secondDefinitionPath]);
await assert.rejects(otherProject.incomingCalls(otherFile, prepared[0].item_id), /item.*invalid/i);
await assert.rejects(changedSession.outgoingCalls(file, prepared[0].item_id), /item.*invalid/i);
```

- [ ] **2. RED:** `npm test -- test/navigation.test.ts test/hierarchy.test.ts test/tools.test.ts`; отсутствуют 6 tools, нет opaque hierarchy isolation. Отдельно проверить forged id и id после crash/restart.
- [ ] **3. Реализовать 6 tools поверх импортированного клиента.** Сохранять все definitions, поддерживать workspace SymbolInformation и объявленный сервером вариант с location; location без range разрешать через workspaceSymbol/resolve, если capability позволяет, иначе ошибка. Hierarchy item хранить без потери data, id генерировать через crypto.randomUUID; после sync/event сначала проверить generation, после restart новый store. Не получать параметры item от пользователя, кроме id. Forward MCP AbortSignal в RequestOptions; read-only annotations у 11 tools, rename write/destructive, openWorldHint=false. `references` продолжает includeDeclaration=true. Обновить metadata serverInfo на `typescript-native-lsp`/`1.1.0` и первоначальные tool-count tests с 6 на 12.
- [ ] **4. GREEN:** новые тесты + предыдущие import/startup/protocol, typecheck. Реальные positions/ожидаемые results по всем инструментам проверяются в задаче 7; fake data не выдавать за подтверждение TypeScript.
- [ ] **5. Коммит:** файлы задачи и provenance; `git commit -m "feat: add TypeScript navigation and opaque call hierarchy tools"`.

### Task 6: Полная валидация и безопасная запись rename

**Files:** Create `P/src/edits.ts`, `P/test/edits.test.ts`; Modify `P/src/{index,lsp-client,pool,protocol,files}.ts`, `P/test/tools.test.ts`.

**Interfaces:** `LspClient.rename(file: string, line: number, character: number, newName: string, options?: RequestOptions): Promise<unknown>` возвращает полный WorkspaceEdit, без предварительного фильтрования ресурсных операций. `prepareWorkspaceEdit(root: string, value: unknown, documents: DocumentSession, io?: EditIO): Promise<PreparedWorkspaceEdit>` полностью проверяет changes/documentChanges, версии, диапазоны и готовит снимки before/after. `applyWorkspaceEdit(prepared: PreparedWorkspaceEdit, io?: EditIO): Promise<RenameResult>`, где `RenameResult = { editCount: number; files: Array<{ file: string; editCount: number }> }`; `EditIO` — Pick из node:fs/promises readFile/writeFile/rename/rm/stat/access/realpath для fault injection. Pool `rename(...): Promise<RenameResult>` выполняет получение, подготовку и запись внутри одного lease; MCP сохраняет смысл upstream success text, ошибки — isError с состоянием затронутых файлов.

- [ ] **1. Написать regressive multi-file rename tests.** Fixture пути `проект #100% с пробелом`, CRLF/BOM, emoji до символа; compare byte diff. Смешанные changes+documentChanges, resource operations, overlapping/duplicate edits, invalid position/version, недоступный файл или symlink за root — отказ до записи. Fault injection: второй write/replace падает; не сообщать успех и не оставлять staged temp files.

```ts
assert.deepEqual(await readBytes(file), expectedAfterBytes); // BOM и CRLF включены в bytes
assert.equal(result.editCount, 3); assert.equal(result.files.length, 2);
await assert.rejects(prepareWorkspaceEdit(root, invalidEdit, docs), /edit|version|project|position/i);
assert.deepEqual(await readAllBytes(), originalBytes);
await assert.rejects(applyWorkspaceEdit(prepared, failingSecondReplaceIO), /rename|write|partial/i);
assert.equal(successReported, false); assert.equal(stagedFiles.length, 0);
```

- [ ] **2. RED:** `npm test -- test/edits.test.ts`; отдельно воспроизвести upstream rename ENOENT на encoded path и частичную запись при непригодном втором файле.
- [ ] **3. Реализовать prepare/apply.** Не молча выкидывать unsupported edits. Разрешить changes либо text-only documentChanges с version=null или совпадающим opened version; reject resource operations/annotations, конфликтующие формы, неоднозначные same-offset edits, overlaps и пути вне realpath проекта. Offset считать по UTF-16 исходного текста, с принятой LSP семантикой BOM; apply в обратном порядке offsets с сохранением исходных EOL/BOM. Проверить доступность/снимки всех файлов до записи, подготовить соседние temp файлы с исходным mode, перепроверить before bytes, затем заменить файлы. При ошибке попытаться вернуть свои уже записанные snapshots; не затирать внешние конкурентные изменения. Если rollback неполный — ошибка перечисляет изменённые/восстановленные файлы. Flush/sync после записи, invalidate hierarchy, в finally удалить temp artifacts. `newName` не shell input; пустую строку отклонять.
- [ ] **4. GREEN:** выбранный тест, tools annotations, typecheck; реальное переименование в специальном пути и независимый `tsc --noEmit` — задача 7. Не обещать межфайловую атомарность файловой системы.
- [ ] **5. Коммит:** файлы задачи и provenance; `git commit -m "fix: validate complete rename edits before writing files"`.

### Task 7: Реальная приёмка TS7 и Windows/Linux CI

**Files:** Create `P/test/native.test.ts`, `P/test/fixtures/project/{tsconfig.json,lib.ts,barrel.ts,main.ts,classes.ts,calls.ts,hints.ts}`, `P/scripts/test-native.mjs`, `.github/workflows/typescript-native-lsp.yml`; Extend `P/test/support.ts`, package scripts и smoke assertions. При реальном расхождении исправлять только владеющий поведением модуль задач 2–6, сохраняя RED/GREEN доказательство.

**Interfaces:** `test-native.mjs` создаёт temporary npm global prefix с pinned TS `7.0.2`, добавляет его bin/shim directory в PATH тестовых процессов и запускает native.test.ts. Никакой глобальной установки в систему пользователя. Native suite вызывает готовый bundle через MCP SDK и независимый compiler через spawn(shell=false); все временные файлы/процессы закрываются в finally. `nativeTestEnv(prefix: string): Promise<NodeJS.ProcessEnv>` в support даёт fixture PATH; штатная глобальная установка macOS проверяется дополнительной пробой resolver.

- [ ] **1. Написать assertions всех 12 инструментов на независимо известных позициях fixture.** Холодные refs: definition/reexport/import/call, ровно 4 места без warm-up. Diagnostics TS2322 и очистка после правки; оба symbol formats подтверждены протокольно, реально — native выдаваемый. Definition fixture overload даёт все определения; interface implementation, workspace symbol, incoming/outgoing hierarchy — известные paths/ranges. Inlay fixture обязан иметь непустые type/parameter hints: конфигурация передаёт `includeInlayParameterNameHints: 'all'`, `includeInlayVariableTypeHints: true`, `includeInlayFunctionLikeReturnTypeHints: true` в формате настроек, который принимает pinned TS7 (формат сверить с его LSP implementation). Нельзя подменять ответ тестовым сервером или считать пустой результат успехом.

```ts
assert.equal(coldReferences.length, 4); assert.deepEqual(sortedColdPlaces, expectedColdPlaces);
assert.match(diagnosticsBefore, /TS2322/); assert.doesNotMatch(diagnosticsAfter, /TS2322/);
assert.ok(hints.length > 0); assert.ok(hints.some(h => /number|value/.test(h.text)));
assert.deepEqual(incomingPlaces, expectedIncomingPlaces); assert.deepEqual(outgoingPlaces, expectedOutgoingPlaces);
assert.equal(afterRenameTsc.exitCode, 0); assert.deepEqual(renameDiff, expectedRenameDiff);
```

- [ ] **2. Написать mutation/lifecycle regressions.** Открытый import удалён → TS2307 как у независимого compiler; query самого missing file → isError. Неоткрытая зависимость меняет тип, новый source и изменение tsconfig отражаются в ответах: bounded poll с интервалом 50 ms и deadline 2000 ms (только проверка, без sleep в production path). Реальное EOF/SIGINT/SIGTERM, два concurrent cold requests одного root, два разных проекта; crash/restart с устаревшим hierarchy id.

```ts
assert.match(afterDeleteDiagnostics, /TS2307/); assert.match(independentTsc.stderrAndStdout, /TS2307/);
assert.ok(freshDependencySeenMs <= 2000); assert.equal(sameRootNativeSpawnCount, 1);
assert.equal(mcpExitObserved, true); assert.equal(remainingOwnedNativePids.length, 0);
assert.equal(unrelatedProcessAlive, true);
```

- [ ] **3. RED:** `npm run build`, `npm run test:live`; сохранить failing assertion и stdout/stderr только тестовых процессов. Если ранее исправленная регрессия проходит, использовать сохранённое RED задачи-владельца, а не искусственно ломать код. Новый дефект сначала локализовать по `superpowers:systematic-debugging`, затем добавить минимальный regression test.
- [ ] **4. Реализовать live runner/fixture/CI и минимальные подтверждённые исправления.** Actions matrix `ubuntu-latest`/`windows-latest`, Node `20` и `24`; шаги npm ci → typecheck → verify-build → test → test:live. Один раз подготовленный prefix переиспользовать между тестами; TSC_PATH-priority тестировать дополнительно. Никаких local-user absolute paths, shell-specific chmod/pkill. CI запускает native TS, а не только mock; временные test artifacts хранить при failure. Итоговый dist пересобрать до verify-build.
- [ ] **5. GREEN:** полная suite/verify-build локально на macOS. После push ветки в задаче 9 дождаться фактических checks через `gh run watch <run-id> --exit-status` и проверить все четыре matrix cells. До push пометить CI pending; недоступный CI или отсутствующие настоящие hints — открытый критерий приёмки, а не успех.
- [ ] **6. Коммит:** только fixture/tests/runner/workflow и выявленные собственные fixes; `git commit -m "test: verify native TypeScript tools and cross-platform lifecycle"`.

### Task 8: Пакет, скилл и локальная установка в Codex

**Files:** Create `.agents/plugins/marketplace.json`, `P/{plugin.json,mcp.json}`, `P/skills/typescript-native-lsp/SKILL.md`, `P/test/package.test.ts`, `P/scripts/codex-check.mjs`; Modify `.claude-plugin/marketplace.json`, `README.md`, `plugins/typescript-native-lsp/README.md`, `P/README.md`, package scripts/notices/provenance/dist. В `plugins/selectel-ops/README.md` и `plugins/apple-notes-folder/README.md` заменить только адрес репозитория.

**Interfaces:** Portable `$schema` из [официальной документации](https://developers.openai.com/plugins/build/plugins): `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` и `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`. Market entry: `source: {source: 'local', path: './plugins/typescript-native-lsp/codex'}`, `policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}`, `category: 'Developer Tools'`; authentication policy присутствует, но реальная аутентификация сервису не нужна (MCP auth.type=none). `codex-check.mjs` принимает `--marketplace <root-or-url>` и необязательный `--ref <ref>`, создаёт отдельный temporary CODEX_HOME, возвращает exit 0 только после установочных assertions; JSON report не содержит credentials.

- [ ] **1. Написать проверки packaging и сохранения Claude contract.** В temp root разместить только необходимые файлы пакета/каталога, без node_modules/исходного repo lookup; проверить manifests, реальные relative paths и annotations из tools/list. Падение без TSC должно происходить только при file tool. Сравнить LSP-конфигурацию Claude и остальные версии с базовым коммитом.

```ts
assert.equal(codexMarket.name, 'yarikmix-plugins'); assert.equal(codexMarket.plugins.length, 1);
assert.equal(codexMarket.plugins[0].source.path, './plugins/typescript-native-lsp/codex');
assert.deepEqual(mcp.mcpServers.typescript_native_lsp.args, ['./dist/server.js']);
assert.equal(mcp.mcpServers.typescript_native_lsp.cwd, './');
assert.deepEqual(claudeTs.lspServers, baselineTs.lspServers); assert.equal(claudeMarket.plugins.length, 3);
assert.equal(claudeTs.version, '1.1.0'); assert.deepEqual(otherPluginVersions, baselineOtherVersions);
assert.equal(installedTools.length, 12); assert.equal(installedSkillName, 'typescript-native-lsp');
```

- [ ] **2. RED:** `npm test -- test/package.test.ts` и первая изолированная install-проба, фиксирующая отсутствие Codex marketplace/skill. Не использовать прямую ручную mcp_servers registration как замену проверке установки плагина.
- [ ] **3. Создать portable manifests/marketplace и скилл.** Реальный `SKILL.md` с name/trigger-description: абсолютные пути, позиции с 0/UTF-16, выбор из 12 tools, hierarchy ids, errors, повтор после короткой задержки dependencies, diagnostics для файла и независимый project typecheck/tests. Rename — только по явной просьбе, quick fixes не применять. README: две установки, матрица поддержки трёх plugins, Node20+/global TS7/TSC_PATH, записывающий rename, отсутствие автоматических push diagnostics и npm install при старте, расхождение global/project TS, ручное upstream update. Имя repo/URL — `YarikMix/agent-plugins`, identifiers `yarikmix-plugins` неизменны.
- [ ] **4. Реализовать `codex-check.mjs` и проверить кэш.** Из temp CODEX_HOME выполнить `codex plugin marketplace add <source> [--ref <ref>]`, `codex plugin add typescript-native-lsp@yarikmix-plugins --json`; проверить скопированный cache root и отсутствие node_modules. Запустить `codex app-server --stdio`, initialize → thread/start в fixture cwd → mcpServerStatus/list → mcpServer/tool/call; server name брать из inventory (host может namespace его). Tools/config должны происходить из установленного плагина. Через skills/list проверить cache-path skill; реально вызвать hover/references/diagnostics и новую navigation tool. Temporary configuration отключает чужие MCP/hooks. Закрыть threads/AppServer и дочерние процессы.
- [ ] **5. Проверить скилл свежей сессией Codex.** По `skill-creator` и `superpowers:writing-skills` приготовить отложенные сценарии до написания скилла: navigation через reexport, diagnostics после правки, чужой hierarchy id, rename request, navigation без просьбы rename. RED — без skill; GREEN — новая сессия с установленным skill. Проверять реальные tool calls/правильные zero-based positions, явный rename только в соответствующем сценарии; статический grep не заменяет поведенческую проверку. Авторизацию наследовать штатно без чтения/копирования auth secrets, persistent user config не менять. Если отдельная сессия не получает штатный login, явно зафиксировать непроведённый GREEN и разрешить причину перед выпуском.
- [ ] **6. GREEN:** `npm run build`, `npm run verify-build`, `npm run typecheck`, обычные тесты/live suite; `npm run test:codex -- --marketplace /absolute/path/to/temp-marketplace-root`. Cache запускается из cwd пакета и работает с fixture project, все 12 tools/skill обнаружены, реальные вызовы успешны. Пересобрать dist и обновить notices включая transitive bundled libraries, проверить публичный lock и отсутствие чужих абсолютных путей.
- [ ] **7. Коммит:** только файлы этой задачи; `git commit -m "feat: package TypeScript native MCP and skill for Codex"`.

### Task 9: Ревью, переименование GitHub и проверка Git-установки

**Files:** Create `docs/superpowers/reports/2026-10-14-ts-mcp-import-verification.md`; при замечаниях — только соответствующие собственные файлы. Изменение имени GitHub/origin — операция выпуска, не изменение других плагинов.

**Interfaces:** Report фиксирует platform/Node/TS/Codex versions, SHA tested bundle/branch, exact results и непроведённые критерии. `test:codex` задачи 8 используется без подмены на local/direct-MCP запуск. Изменение origin делается командами git, без чтения `.git/config`.

- [ ] **1. Ревью всей ветки по исходной спеке.** Применить `superpowers:requesting-code-review` и `superpowers:verification-before-completion`; при native execution — отдельный reviewer, при subagent-driven — финальное branch review сверх task reviews. Проверить все строки приёмки и пять Review Focus, происхождение/MIT, write boundaries, process ownership, cached packaging и отсутствие порта других plugins. Сверить `git diff --check` и `git status`; findings закрыть тестируемыми fixes и scope-коммитами.
- [ ] **2. Зафиксировать локальные результаты, push task branch и дождаться CI.** `git push origin codex-typescript-native-lsp` без force. Проверить remote HEAD, открыть draft PR с конкретным поведением, validation и честными ограничениями (если PR ветки уже существует — обновить). Отчёт должен различать реальные macOS/Windows/Linux и mock tests. Не переименовывать repo при незакрытом required acceptance failure.
- [ ] **3. Переименовать уже разрешённый пользователем репозиторий:** `gh api --method PATCH repos/YarikMix/claude-plugins -f name=agent-plugins`. Перед mutation проверить owner/name/current state через read-only API; если он уже переименован, повторный PATCH не делать. Git rename remote URL не печатает credentials: установить SSH URL `git@github.com:YarikMix/agent-plugins.git` командой `git remote set-url origin ...` для задачного клона; worktree разделяет remote с основным клоном. Проверить fetch/ls-remote и разрешение старого GitHub URL в новый. Не запрашивать повторно общее разрешение на rename.
- [ ] **4. Проверить установку по GitHub:** `npm run test:codex -- --marketplace YarikMix/agent-plugins --ref codex-typescript-native-lsp`. Ожидается новая кэшированная копия без node_modules, 12 tools/skill, реальные вызовы и cleanup. Проверить старый URL на HTTP/API redirect без обещания его вечной поддержки. Обновить PR ссылки/описание и отчёт после rename.
- [ ] **5. Закрыть release gate:** сохранить отчёт scope-коммитом `git commit -m "docs: record TypeScript Codex plugin verification"`, push обновления, дождаться актуального CI. Default-branch merge выполняется по выбранному пользователем способу завершения ветки через `superpowers:finishing-a-development-branch`; сама задача и переименование уже разрешены, approval нужно только для ещё не выбранного merge. После разрешённого merge повторить `test:codex` с `YarikMix/agent-plugins` **без --ref**, чтобы подтвердить команды README. До merge не утверждать, что обычная установка из main доступна. Финальный ответ: URL repo/PR, что работает, что реально проверено и оставшиеся ограничения.

## Самопроверка плана

- Импорт/лицензия/standalone build → 1; глобальный TS/lazy → 2; pool/timeout/cancel/process cleanup → 3; URI/document sync/response normalization → 4.
- Все 12 инструментов/capabilities/hierarchy/annotations → 5; полный WorkspaceEdit/EOL/BOM/ошибки записи → 6; реальные regressions, непустые hints, freshness и cross-platform → 7.
- Portable package/marketplace/cache/skill/Claude compatibility/docs → 8; branch review/GitHub rename/origin/new+old URLs/Git install/report → 9.
- Общие типы определяются до потребителей; изменения `rename` signature обозначены в задаче 6. Discovery checks сначала ждут 6 tools импортированной базы, затем обновляются до 12 в задаче 5. Fake regressions не подменяют живую приёмку.
- Все пять Review Focus имеют конкретные assertions в задачах-владельцах. Каждый программный результат имеет RED, implementation, GREEN и path-scoped commit; выпуск имеет проверяемые операции и отдельный merge gate.
