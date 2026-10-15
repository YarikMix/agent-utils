# Apple Notes для Claude Code и Codex — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Установка одного Apple Notes MCP-плагина в Claude Code и Codex через `YarikMix/agent-utils`, с независимой папкой и картинками только из пользовательских вложений текущего диалога.

**Architecture:** Общие операции Apple Notes сохраняются; адаптеры хостов отвечают за настройки, контекст диалога и подтверждение вложений. Клиентский хук выдаёт одноразовый `attachment_ticket`, сервер проверяет его и использует закрытые снимки исходных байтов. Реализация начинается только после положительной проверки реальных контрактов обоих клиентов в Task 1.

**Tech Stack:** macOS, Node.js ≥ 20, TypeScript, MCP SDK `1.30.1`, Zod `3.25.76`, marked `18.0.14`, turndown `7.2.4`, esbuild, Vitest; новые зависимости не требуются.

**Spec:** [2026-10-15-apple-notes-claude-codex-design.md](../specs/2026-10-15-apple-notes-claude-codex-design.md), коммит `a497a81`.

## Global Constraints

- Репозиторий называется `YarikMix/agent-utils`; переименование GitHub уже выполнено.
- Один сервер; независимые настройки Claude и Codex; ровно семь существующих MCP-инструментов.
- Идентификатор каталога `yarikmix-plugins`; версия Apple Notes в обоих каталогах `2.0.0`.
- Локальный macOS, Node.js не ниже 20; целевая первичная проверка: Codex CLI `0.162.1`, Claude Code `2.1.300`.
- Настройка Codex: `$CODEX_HOME/agent-utils/apple-notes-folder/config.json`, fallback `~/.codex`; версия формата `1`, ключ `folder`.
- Каталоги `0700`, закрытые файлы `0600`; атомарная запись настроек и публикация допусков.
- Срок допуска — 15 минут; снимки хранятся до 24 часов, активная операция их не удаляет.
- Картинки: только пользовательские вложения текущего диалога, PNG/JPEG/GIF/HEIC/WebP по сигнатуре, до 10 МБ; неизвестное происхождение — отказ.
- Сохранённые байты вложения либо хеш/копия при получении сообщения обязательны: поздно прочитанного `localImage.path` недостаточно.
- Нет сетевых функций сервера, Full Disk Access, произвольных корней файлов или MCP-инструмента смены папки.
- Сохраняются проверки container, защищённых заметок, вложений, списков, обрезки и таймаута записи из исходной спеки.
- `dist/` закоммичен и воспроизводим; установка без npm/build; исторические спеки и планы не переписываются.
- Не читать секреты и `.git/config`, не печатать env; не использовать `codex mcp add/remove`, не отключать hook trust.
- `selectel-ops` и TypeScript LSP сохраняются для Claude, их перенос в Codex не входит в задачу.
- Работать в существующем worktree ветки `apple-notes-codex`; основной checkout и соседние ветки не переключать.

## Review Focus

1. Атомарная замена файла по тому же пути после получения вложения: не вставить новые байты под прежним разрешением — Task 3/4.
2. Два параллельных MCP-вызова с одним билетом: допуск потребляет ровно один вызов, второй не пишет заметку — Task 4/6.
3. Markdown с вложенными/reference-картинками, пробелами и кириллицей: hook и конвертер видят один и тот же набор ссылок — Task 5/6.
4. Оборванный последний JSONL-фрагмент при чтении transcript: отказ картинке и возможность повторить, без разрешения посторонних файлов и без поломки текста — Task 3/5.
5. При добавлении каталога CLI переписывает чужие настройки: сохранить пометки AI Launcher и другие MCP, иначе выполнить установку через точечный безопасный способ — Task 8.

---

## Файлы, обязанности и порядок

Все пути `src/`, `test/`, `scripts/`, `dist/` ниже относительно
`plugins/apple-notes-folder/`, если явно не указано «корень репозитория».
Команды npm выполняются из этого каталога; git — из корня worktree.
Номера строк относятся к базе `eed751a`, после предыдущих задач искать по имени функции.

| Файлы | Ответственность | Задача |
|---|---|---|
| `scripts/probe-host.mjs`, `test/fixtures/hosts/{claude,codex}.json`, корневой `docs/superpowers/research/2026-10-15-apple-notes-client-contracts.md` | Проверка реального контракта, обезличенные события и результат допуска | 1 |
| `src/hosts/types.ts`, `src/hosts/paths.ts`, `src/hosts/config.ts`, `src/configure-cli.ts` | Общие типы, закрытые каталоги, независимая настройка Codex | 2 |
| `src/hosts/claude.ts`, `src/hosts/codex.ts`, `src/hosts/attachments.ts` | Нормализация событий и извлечение исходных вложений одного диалога | 3 |
| `src/attachments/tickets.ts`, `src/attachments/snapshots.ts`, `src/markdown.ts` | Одноразовые допуски, хеши аргументов, копии, очистка и единый разбор image-ссылок | 4 |
| `src/attachment-hook.ts`, `src/hook.ts`, `src/hook-cli.ts` | Реклама ссылок вложений, выдача билета для точного вызова, защитный хук | 5 |
| `src/{server,tools,images,errors,scope,runner}.ts` | Подключение host/config/tickets к семи существующим инструментам | 6 |
| Манифесты, каталоги, `skills/setup/SKILL.md`, сборка, README | Установка, настройка, обе упаковки и версия `2.0.0` | 7 |
| `scripts/live-check.mjs`, корневой research-отчёт приёмки | Проверка Notes и установленных плагинов в обоих клиентах | 8 |

Зависимости: `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`.
Это один последовательный план: задача с неизвестным контрактом не передаёт
соседней задаче догадки вместо зафиксированного интерфейса.

### Общие типы, которые вводит Task 2

В `src/hosts/types.ts` экспортировать следующие типы без логики:

```ts
type Host = 'claude' | 'codex';
type WriteToolName = 'notes_create' | 'notes_append' | 'notes_update';
type WriteArgs = { markdown: string; title?: string; id?: string; attachment_ticket?: string };
type RuntimePaths = { configFile: string | null; runtimeDir: string };
type AttachmentContext = { host: Host; sessionId: string; callId: string; transcriptPath: string };
type VerifiedAttachment = { href: string; aliases: string[]; bytes: Uint8Array; sha256: string };
type ImageGrant = { href: string; snapshotPath: string; sha256: string };
type TicketLease = { images: ImageGrant[]; release: () => Promise<void> };
type PreparedImages = { resolve: (href: string) => Promise<string>; release: () => Promise<void> };
type Clock = () => number; // Date.now(), миллисекунды
```

`href` для inline-вложения — `attachment:<sha256>`, где sha256 — 64 строчных
hex-символа от исходных байтов. `aliases` — только реальные пути из метаданных
этого же вложения, если такие пути есть; произвольные пути не добавляются.
Hook сообщает агенту доступные `href` через additionalContext, не раскрывая байты.
Билет выдаётся для исходных аргументов; преобразование ссылок в file-URL происходит
в сервере. `attachment_ticket` исключается из хеша аргументов.

## Task 1: Подтвердить контракт клиентов до продуктовой реализации

**Files:** Create `scripts/probe-host.mjs`, `test/fixtures/hosts/{claude,codex}.json`,
корневой `docs/superpowers/research/2026-10-15-apple-notes-client-contracts.md`.

**Interfaces:**
- Consumes: установленные клиенты, текущие MCP SDK/Node, синтетический PNG 1×1 из `scripts/live-check.mjs:29`.
- Produces: обезличенные события реальных версий; отчёт с полями `client`, `version`, `sessionBinding`, `originalBytes`, `rewriteReceived`, `attachmentRefsVisible`, `packagingIsolation`, `guardBlocked`, `codeModeBlocked` (последнее обязательно для Codex).
- Gate: все поля возможностей истинны в двух клиентах; отсутствие логина/доверия не считается успехом или доказательством несовместимости.

- [ ] **Step 1: Подготовить зависимости и проверить исходное состояние.** Выполнить по отдельности `npm ci`, `npm test`, `npm run typecheck`, `npm run verify-build`. Ожидается PASS; это выполняется при исполнении плана, а не при его написании.
- [ ] **Step 2: Создать изолированный probe через `probe-host.mjs`.** Это development-helper с режимами `prepare --client <host> --out <dir>`, `hook`, `server`, `verify --out <dir>`. `prepare` создаёт временный плагин с одним инструментом `probe_attachment({marker, markdown, attachment_ticket?})`, записью MCP/hook и синтетическим PNG. Раскладка повторяет предлагаемую: оба host-манифеста, Codex root `.mcp.json`, inline MCP Claude, явные разные hooks. Сервер записывает фактически полученные client-аргументы и служебный folder-marker: ни один клиент не должен запустить конфигурацию другого через автообнаружение. К Notes probe не обращается. Сырые события хранятся только в закрытом scratch-каталоге. Секреты и личные диалоги не копировать.
- [ ] **Step 3: Снять отрицательный результат.** Подключить probe в свежем авторизованном диалоге каждого клиента, прикрепить PNG штатным способом, вызвать инструмент с marker `before`. До переписывания в hook сервер не должен видеть `attachment_ticket`; verifier завершает проверку с кодом 1 и причиной `rewriteReceived=false`.
- [ ] **Step 4: Включить переписывание только в probe-хуке.** Вернуть `updatedInput` с `attachment_ticket: 'probe-v1'`, повторить вызов с marker `after`. Получить реальное событие с session/transcript, исходные байты/достоверный снимок вложения, а также подтверждение, что сервер действительно получил `probe-v1`. В дополнительном прогоне заменить собственный исходный PNG после приёма сообщения, но до tool-call: доказательством служат прежние байты из payload или снимка, сделанного hook-интеграцией при получении сообщения. Копия PNG, сохранённая тестом до запуска клиента, и впервые вычисленный перед tool-call хеш доказательством host-контракта не являются. Для additionalContext сообщить модели не названный в промпте href и проверить, что он действительно пришёл в аргументах probe-сервера.
- [ ] **Step 5: Проверить защищающий хук probe.** Probe-хук блокирует синтетическую команду-marker, не обращающуюся к Notes. Выполнить её через обычный shell и Codex Code Mode, проверить отсутствие эффекта команды. Доверие хуку подтвердить штатно; не применять bypass-флаги. Для attachment-теста Claude использовать свежий `claude -p --plugin-dir <probe-dir> --input-format stream-json --output-format stream-json --verbose --replay-user-messages`, подавая PNG в пользовательском image-блоке; Codex — свежий локальный диалог с `--image <png>`. Фактические команды и installation source записать в отчёт.
- [ ] **Step 6: Зафиксировать проверяемое доказательство.** Verifier должен вычислять итог из событий, а не из ответов модели. Его итоговые проверки:

```js
assert.equal(reports.length, 2);
for (const r of reports) {
  for (const k of ['sessionBinding', 'originalBytes', 'rewriteReceived', 'attachmentRefsVisible', 'packagingIsolation', 'guardBlocked']) assert.equal(r[k], true);
  if (r.client === 'codex') assert.equal(r.codeModeBlocked, true);
}
```

- [ ] **Step 7: Обезличить fixtures и пройти gate.** Оставить только структуру собственных тестовых сообщений, синтетические байты и фиктивные идентификаторы/пути. Файл fixture имеет `{version, preToolUse, userPromptSubmit, transcriptRecords, expected}`; raw-формы внутри берутся из наблюдения, а не из придуманных примеров. В research описать точные JSON-поля и момент доступности исходных байтов. Если хотя бы один контракт не подтверждён, остановиться перед Task 2 и вернуться к ревью спеки; не реализовывать запасной доступ к произвольным файлам.
- [ ] **Step 8: Commit.** Добавить только helper, две обезличенные fixtures и research; `git commit -m 'test(apple-notes): verify Claude and Codex attachment contracts'`.

## Task 2: Независимая настройка Codex и общие пути

**Files:** Create `src/hosts/{types,paths,config}.ts`, `src/configure-cli.ts`,
`test/{host-config,configure}.test.ts`; Modify `src/scope.ts:24`, `src/errors.ts:26`.

**Interfaces:**
- Consumes: существующие `Runner`, `Scope`, `configuredFolder(env)`, `resolveScope`.
- Produces в `hosts/paths.ts`: `parseHost(argv: string[]): Host` (только `--client claude|codex`, отсутствие флага → Claude для совместимости); `hostPaths(host: Host, env: NodeJS.ProcessEnv, home: string): RuntimePaths`; `configurationHint(host: Host): string`. В `hosts/config.ts`: `readFolder(host: Host, env: NodeJS.ProcessEnv, home: string): Promise<string|null>`; `configureCodex(folder: string, env: NodeJS.ProcessEnv, home: string, run: Runner): Promise<Scope>`.
- `resolveScope(name: string|null, run: Runner, hint?: string): Promise<Scope>` и `makeScopeProvider(name: string|null, run: Runner, hint?: string): () => Promise<Scope>` получают необязательную host-подсказку; default сохраняет Claude. Ошибка повреждённого config — `ToolError('CONFIG', ...)`, не необработанный JSON SyntaxError.
- Пути: Codex runtime `$CODEX_HOME/agent-utils/apple-notes-folder/runtime`, fallback `~/.codex`; Claude runtime `${CLAUDE_CONFIG_DIR:-~/.claude}/agent-utils/apple-notes-folder/runtime`, `configFile=null`. Расширять `~` только у fallback home, не переопределять системный HOME.

- [ ] **Step 1: Написать RED-тесты.** В `beforeEach` создать закрытый temp-home и Runner с двумя однозначными папками `ClaudeFolder`, `CodexFolder`. Проверки:

```ts
expect(parseHost([])).toBe('claude');
expect(() => parseHost(['--client', 'other'])).toThrow();
await configureCodex('CodexFolder', { CODEX_HOME: codexHome }, home, run);
expect(await readFolder('claude', { NOTES_FOLDER: 'ClaudeFolder', CODEX_HOME: codexHome }, home)).toBe('ClaudeFolder');
expect(await readFolder('codex', { NOTES_FOLDER: 'Wrong', CODEX_HOME: codexHome }, home)).toBe('CodexFolder');
expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({ version: 1, folder: 'CodexFolder' });
expect((await stat(configFile)).mode & 0o777).toBe(0o600);
expect((await stat(dirname(configFile))).mode & 0o777).toBe(0o700);
```

Также отдельные тесты: missing → null, malformed JSON/unknown version → CONFIG; пустая, Recently Deleted, отсутствующая и неоднозначная папки не меняют прежний файл; проверка настройки вызывает только listFolders с `write:false`; изменение runtime/cache не удаляет config.
- [ ] **Step 2: Запустить RED.** `npm test -- test/host-config.test.ts test/configure.test.ts`; ожидается FAIL по отсутствующим экспортам.
- [ ] **Step 3: Реализовать exports и CLI.** Конфиг писать через temp-файл в том же закрытом каталоге и rename только после `resolveScope`; ошибка оставляет прежние байты. `configure-cli.ts --folder <name>` вызывает `configureCodex`, печатает только статус и необходимость перезапуска MCP. Проверить folder-аргумент, не добавлять reset/all-folders режимов. Подсказка Codex: `$apple-notes-folder:setup`; Claude — прежняя команда.
- [ ] **Step 4: Проверить GREEN.** Та же команда и `npm run typecheck`; PASS, старые scope/error-тесты проходят.
- [ ] **Step 5: Commit.** Только перечисленные файлы; `git commit -m 'feat(apple-notes): add independent Codex folder configuration'`.

## Task 3: Адаптеры событий и подтверждённых исходных вложений

**Files:** Create `src/hosts/{claude,codex,attachments}.ts`, `test/host-attachments.test.ts`; Modify `src/errors.ts` (код IMAGE_PROVENANCE);
использовать fixtures Task 1, не добавлять обходные fixtures с секретами.

**Interfaces:**
- Consumes: `Host`, `AttachmentContext`, `VerifiedAttachment` из Task 2 и реальные формы Task 1.
- Produces в каждом `hosts/claude.ts` и `hosts/codex.ts`: `parseToolContext(raw: unknown): AttachmentContext|null`, `parseSessionContext(raw: unknown): Omit<AttachmentContext,'callId'>|null`, `readAttachments(context: Omit<AttachmentContext,'callId'>): Promise<VerifiedAttachment[]>`. В dispatcher `hosts/attachments.ts`: `readVerifiedAttachments(context: Omit<AttachmentContext,'callId'>): Promise<VerifiedAttachment[]>`, выбирающий адаптер по host. Tool-context также подходит структурно. Host фиксируется адаптером; sessionId/transcriptPath проверяются на непустоту и согласованность с сессией; callId обязателен только для tool-context. В `errors.ts` добавить IMAGE_PROVENANCE в ErrorCode.
- Адаптер читает только transcriptPath из текущего hook; inline bytes либо подтверждённый в момент сообщения snapshot/hash. Каждый result имеет SHA-256 исходных байтов, `href=attachment:<sha256>` и aliases только из метаданных этой записи. Неизвестный/неполный формат — `ToolError('IMAGE_PROVENANCE', ...)`, не пустой список разрешений ко всему tmp.

- [ ] **Step 1: Написать RED-тесты по обеим реальным fixtures.** В тесте материализовать обезличенный transcript во временном каталоге; ожидаемые PNG-байты берутся из собственного fixture. Проверить:

```ts
expect(result).toEqual([{ href: `attachment:${sha}`, aliases: expectedAliases, bytes: pngBytes, sha256: sha }]);
expect(await readVerifiedAttachments(previousMessageContext)).toEqual(result);
expect(await readVerifiedAttachments(toolResultOnlyContext)).toEqual([]);
await expect(readVerifiedAttachments(foreignSessionContext)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
await expect(readVerifiedAttachments(truncatedJsonlContext)).rejects.toMatchObject({ code: 'IMAGE_PROVENANCE' });
```

Отдельно: текстовое упоминание пути не даёт alias; `view_image`, generated image и screenshot tool-results не дают вложений; localImage без достоверного исходного хеша отклоняется; файл по правильному пути с заменёнными байтами отклоняется; путь с пробелами/кириллицей из настоящих метаданных сохраняется. Подмена symlink вместо исходного файла также отклоняется.
- [ ] **Step 2: Запустить RED.** `npm test -- test/host-attachments.test.ts`; FAIL по отсутствующей реализации.
- [ ] **Step 3: Реализовать адаптеры.** Точные raw-поля и распознанные формы — только из Task 1. Проверить роль пользователя, сессию и источник байтов до формирования VerifiedAttachment; декодировать inline без сети, размер проверять до чрезмерного выделения памяти. Для сохранённого файла читать открытый fd и сравнивать с исходным хешем, не вычислять новый «эталон» из текущего пути. Ошибки не включают текст сообщения или base64.
- [ ] **Step 4: Проверить GREEN.** Та же команда, `npm run typecheck`; все сценарии проходят. Дополнить research списком поддержанных форм без заявления о непроверенных версиях.
- [ ] **Step 5: Commit.** `git commit -m 'feat(apple-notes): verify current-dialog user attachments per host'`.

## Task 4: Закрытые снимки и одноразовые допуски

**Files:** Create `src/attachments/{snapshots,tickets}.ts`, `test/{snapshots,tickets}.test.ts`;
Modify `src/images.ts:1-65` (добавить проверку байтов), `src/markdown.ts:65-74` (общий imageHrefs), `src/errors.ts` (код IMAGE_TICKET), `test/markdown.test.ts`.

**Interfaces:**
- Consumes: `Host`, `WriteToolName`, `WriteArgs`, `VerifiedAttachment`, `ImageGrant`, `TicketLease`, `RuntimePaths`, `Clock`.
- Produces в images: `sniffImageMime(head: Buffer): string|null` и `validateImageBytes(bytes: Uint8Array): void`; лимит `MAX_IMAGE_BYTES=10*1024*1024`.
- snapshots: `saveSnapshot(runtimeDir: string, attachment: VerifiedAttachment): Promise<ImageGrant>`; `verifySnapshot(runtimeDir: string, grant: ImageGrant): Promise<string>` возвращает проверенный file-URL.
- В `markdown.ts`: `imageHrefs(markdown: string): string[]` — уникальные ссылки в порядке первого появления, через существующий marked lexer/walkTokens; markdownToHtml использует этот же обход, не regex. В tickets: `issueTicket(paths: RuntimePaths, context: AttachmentContext, name: WriteToolName, args: WriteArgs, attachments: VerifiedAttachment[], now?: Clock): Promise<string>`; `consumeTicket(paths: RuntimePaths, host: Host, name: WriteToolName, args: WriteArgs, now?: Clock): Promise<TicketLease>`; `cleanupRuntime(paths: RuntimePaths, now?: Clock): Promise<void>`.
- issueTicket сам выбирает только imageHrefs(args.markdown), сопоставляя их с href/aliases подтверждённых вложений; неизвестная ссылка отменяет весь выпуск. Для каждой использованной ссылки ImageGrant.href равен именно ссылке из Markdown, копия байтов может быть общей по sha256. В errors добавить IMAGE_TICKET. Lease.release снимает marker активной операции, но не возвращает ticket и не удаляет снимок досрочно.
- Билет: случайные 32 байта → hex, basename без разделителей; JSON `version=1`, host/sessionId/callId/tool/argsHash/issuedAt/expiresAt/images. SHA-256 аргументов — канонический JSON с рекурсивно сортированными ключами без `attachment_ticket`; байты Markdown не нормализовать. `expiresAt=issuedAt+900000`. Claim — атомарный rename ticket в consumed; неизвестный/просроченный/повторный — `IMAGE_TICKET`. Снимки адресуются sha256 и живут `86400000` мс; consumed ticket не позволяет исполнить запись повторно.

- [ ] **Step 1: Написать RED-тесты.** Создать собственные PNG/JPEG/GIF/HEIC/WebP, temp runtime, контекст текущего host и Clock `() => 1000`. Проверки:

```ts
expect(ticket).toMatch(/^[a-f0-9]{64}$/);
const lease = await consumeTicket(paths, 'codex', 'notes_create', { ...args, attachment_ticket: ticket }, () => 1001);
expect(lease.images).toHaveLength(1);
await lease.release();
await expect(consumeTicket(paths, 'codex', 'notes_create', { ...args, attachment_ticket: ticket }, () => 1002)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
expect((await Promise.allSettled(twoConcurrentConsumes)).filter(r => r.status === 'fulfilled')).toHaveLength(1);
await expect(consumeTicket(paths, 'codex', 'notes_create', expiredArgs, () => 901000)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
expect(() => validateImageBytes(new Uint8Array(10 * 1024 * 1024 + 1))).toThrow();
```

Дополнить: истёкший ровно на границе билет, неизвестный host/tool/args; перестановка ключей JSON допустима, изменение Markdown — нет; `../` в ticket; подмена snapshot, symlink файла/каталога и выход realpath за runtime; неверная сигнатура; успешная проверка каждого формата; 10 МБ включительно; режимы `0700/0600`; очистка удаляет только просроченные собственные файлы и не удаляет активные/свежие снимки. После выдачи билета подменить исходный alias — verify использует прежние bytes snapshot.
- [ ] **Step 2: Запустить RED.** `npm test -- test/snapshots.test.ts test/tickets.test.ts test/images.test.ts`; ожидается FAIL новых кейсов.
- [ ] **Step 3: Реализовать хранилище и consume.** Проверять manifest/version/контейнеры до чтения произвольных путей. Публиковать ticket последним после записи всех снимков; не выдавать частичный допуск. Читать через fd без следования конечной symlink, fstat и hash из тех же байтов. Claim атомарный между процессами; active marker содержит pid владельца и время. Release удаляет active marker в finally, consumed остаётся необратимым. Cleanup сохраняет снимки живых active claims и неистёкших ticket; при повторном использовании sha256 срок хранения отсчитывается от последней выдачи. Orphan claims с завершившимся pid очищаются после 24 часов, сомнение в живости владельца сохраняет снимок. До проверки вернуть lease.release при ошибке чтения snapshot, чтобы claim не завис. Старые imageSrc/defaultImageRoot пока оставить для сборки server до Task 6, новые пути их не используют.
- [ ] **Step 4: Проверить GREEN.** Та же команда, `npm test -- test/markdown.test.ts`, `npm run typecheck`; PASS. Прежние image-тесты пока сохранены; замена production-политики и их ожиданий выполняется в Task 6 одним проверяемым изменением.
- [ ] **Step 5: Commit.** `git commit -m 'feat(apple-notes): bind one-use image grants to exact tool calls'`.

## Task 5: Клиентские хуки подтверждения и сохранение защиты shell

**Files:** Create `src/attachment-hook.ts`, `test/attachment-hook.test.ts`;
Modify `src/hook.ts:17-40`, `src/hook-cli.ts:1-5`, `test/hook.test.ts`.

**Interfaces:**
- Consumes: parseHost/hostPaths Task 2; адаптеры Task 3; issueTicket Task 4; общая `imageHrefs(md)` из Task 4; существующий `shouldDeny(command): boolean`.
- Produces: `attachmentHook(host: Host, input: unknown, paths: RuntimePaths, now?: Clock): Promise<string>` в `attachment-hook.ts`; `runHook(host: Host, input: string, paths: RuntimePaths, now?: Clock): Promise<string>` в `hook.ts`.
- `runHook` сначала выполняет прежний shell guard; для write MCP-вызова — attachmentHook; для UserPromptSubmit — additionalContext с допустимыми href; остальные события не меняет. Точный namespace трёх write-tools берётся из наблюдений Task 1, без совпадения по одному общему суффиксу чужого сервера.
- Успех выдачи билета: `hookSpecificOutput={hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...originalInput,attachment_ticket:ticket}}`; отказ картинке — `permissionDecision:'deny'` с причиной, без частично переписанного Markdown. Для текстового вызова вывод пустой и transcript не читается.

- [ ] **Step 1: Написать RED-тесты.** Для обеих fixtures Task 1 сопоставить write-вызов, VerifiedAttachment и args. Наблюдать выпуск билета через реальный временный runtime, не подменяя файловую проверку. В tests подготовить input с настоящим image href и второй input с текстом:

```ts
const out = JSON.parse(await runHook('codex', JSON.stringify(imageInput), paths, now));
expect(out.hookSpecificOutput.updatedInput.markdown).toBe(args.markdown);
expect(out.hookSpecificOutput.updatedInput.attachment_ticket).toMatch(/^[a-f0-9]{64}$/);
expect(await runHook('codex', JSON.stringify(textInput), paths, now)).toBe('');
expect(transcriptReadCountForText).toBe(0);
expect(JSON.parse(await runHook('claude', JSON.stringify(deniedShell), paths, now)).hookSpecificOutput.permissionDecision).toBe('deny');
```

Другие тесты: reference-image и вложенная картинка используют те же href, что converter; unsupported transcript → deny картинки, но shell guard работает; старая/поддельная `attachment_ticket` в исходных аргументах заменяется только новым проверенным ticket, никогда не считается доказательством; чужой MCP с похожим именем не получает допуск; неизвестный protocol event не выдаёт ticket; prompt additionalContext содержит только безопасные href, не байты/текст сообщений. При недоступном prompt-контексте PreToolUse может отказать с доступными безопасными href для повторного вызова; молча разрешать файл нельзя.
- [ ] **Step 2: Запустить RED.** `npm test -- test/attachment-hook.test.ts test/hook.test.ts`; FAIL новых кейсов.
- [ ] **Step 3: Реализовать композицию.** `hook-cli` читает stdin, выбирает явный host, вычисляет paths и печатает только результат runHook; ошибки происхождения превращает в deny, stdout не засоряет логами. Прежний `hookOutput(input)` оставить синхронным wrapper для shell-логики и старых тестов; новая CLI вызывает async runHook. Сохранить `Bash|Monitor` Claude и нормализованный Bash Codex; не разбирать JS функции exec как shell-текст в обход нормального события вложенного вызова.
- [ ] **Step 4: Проверить GREEN.** Та же команда и `npm run typecheck`; PASS. Перед изменением CLI фиксировать, что bundled `dist/hook.js` пересобирается через существующий pretest, а не тестируется старая версия.
- [ ] **Step 5: Commit.** `git commit -m 'feat(apple-notes): issue attachment grants from client tool hooks'`.

## Task 6: Подключить конфигурацию и билеты к семи инструментам

**Files:** Modify `src/server.ts:1-31`, `src/tools.ts:8-125`, `src/images.ts`,
`src/errors.ts:1-57`, `src/scope.ts:50-62`, `src/runner.ts`, `test/{tools,server.smoke,errors,images,scope,runner}.test.ts`;
Create `test/attachment-integration.test.ts`.

**Interfaces:**
- Consumes: `readFolder/configurationHint/hostPaths`, `consumeTicket/verifySnapshot`, `imageHrefs`, `ImageResolver` из markdown.
- Produces: заменить `ToolDeps.imageSrc` на `prepareImages(name: WriteToolName, args: WriteArgs): Promise<PreparedImages>`; остальные `getScope` и `run` сохранить.
- В `tickets.ts` добавить `makeImagePreparer(host: Host, paths: RuntimePaths, now?: Clock): (name: WriteToolName, args: WriteArgs) => Promise<PreparedImages>` без импорта tools.ts. PreparedImages.resolve берётся из проверенных ImageGrant, release — из TicketLease; при ошибке создания resolver lease снимается до throw. Для текста вернуть resolver, отклоняющий любой image href, и no-op release; ticket не потребляется.
- В shapes трёх write-tools добавить `attachment_ticket: z.string().regex(/^[a-f0-9]{64}$/).optional()`; handler передаёт целые args в prepareImages ровно один раз. PreparedImages.resolve использует только href→проверенный file-URL из consume/verify, без запасного чтения исходного пути; PreparedImages.release вызывается в finally после попытки NotesService, включая TIMEOUT_WRITE. Для текста не нужны ticket/transcript.
- Ошибки `IMAGE_PROVENANCE`, `IMAGE_TICKET` уже введены Tasks 3/4; сохранять `IMAGE` для формата/размера и `IMAGE_REF` для note-image. VERSION из `src/version.ts` вводится Task 7; до неё текущая константа версии не меняется. Для host-подсказки FOLDER_GONE расширить `mapOsaFailure(err, stderr, write, hint?: string): ToolError` и `makeOsascriptRunner(exec?: ExecFn, hint?: string): Runner`, default — прежний Claude hint; server передаёт hint своего хоста.

- [ ] **Step 1: Написать RED-тесты.** Переработать setup существующего tools.test: сохраняется fakeNotes, вместо неограниченного imageSrc вводится prepareImages на реальном ticket store. В новом integration-тесте передавать образцы hook-событий Task 1 в runHook, затем его updatedInput в зарегистрированный handler. Проверить:

```ts
await expect(create({ title: 'Тест', markdown: '![](/private/tmp/claude-1/arbitrary.png)' })).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
expect(writes).toHaveLength(0);
await create(validHookOutput.hookSpecificOutput.updatedInput);
expect(writes).toHaveLength(1);
expect(savedHtml).toContain('file://');
await expect(create(validHookOutput.hookSpecificOutput.updatedInput)).rejects.toMatchObject({ code: 'IMAGE_TICKET' });
expect(writes).toHaveLength(1);
```

Отдельные кейсы: для create/append/update одна неверная из нескольких картинок даёт 0 записей; неоднозначная папка/locked/outside/lists/attachments/truncated сохраняют прежние отказы; истёкший билет и подмена snapshot дают 0 записей; повтор после TIMEOUT_WRITE требует нового билета, не повторяет старый, active marker снят; PNG-reference в Markdown и code-fence с текстом `![](...)` различаются (в code-fence ticket не нужен). Raw HTML `<img>` экранируется и файл не читается. Текстовая операция работает при отсутствующем transcript. FOLDER_GONE в Codex содержит setup hint и не содержит `/plugin configure`.
- [ ] **Step 2: Запустить RED.** `npm test -- test/tools.test.ts test/attachment-integration.test.ts test/server.smoke.test.ts`; FAIL новых ограничений.
- [ ] **Step 3: Реализовать интеграцию.** Server выбирает host и читает config один раз; CONFIG-ошибку сохраняет как getScope, чтобы процесс отвечал, а не завершался при старте. makeScopeProvider по-прежнему повторяет временную ошибку разрешения Notes, но не перечитывает config посреди сессии. Для write: сначала прежние чистые проверки (TRUNCATED и imageHrefs с `note-image:N` → IMAGE_REF до проверки ticket), затем prepareImages и конвертация всего Markdown, только затем NotesService; release в finally. Удалить production `imageSrc`/`defaultImageRoot` и любые fallback tmp-пути. Не менять JXA/notes.ts ради нового допуска.
- [ ] **Step 4: Проверить GREEN и регрессию.** `npm test`, `npm run typecheck`; оба PASS. Расширить smoke запуском `dist/server.js --client claude` и `--client codex` с пустым temp-home: ровно семь имён, корректная host-подсказка, malformed config не роняет stdio, удаления/перезапись остаются destructive. Тесты не обращаются к реальным заметкам при пустой конфигурации.
- [ ] **Step 5: Commit.** `git commit -m 'feat(apple-notes): enforce attachment provenance in MCP writes'`.

## Task 7: Упаковка двух клиентов, setup и воспроизводимая версия 2.0.0

**Files:** Create `.codex-plugin/plugin.json`, `.mcp.json`, `hooks/{claude,codex}.json`,
`skills/setup/SKILL.md`, `src/version.ts`, `test/packaging.test.ts`, `assets/icon.svg`;
Modify `.claude-plugin/plugin.json`, удалить прежний `hooks/hooks.json` после явных ссылок,
`scripts/build-options.mjs:4`, `package.json`, `package-lock.json`, `dist/*`, `src/server.ts`, `README.md`;
в корне репозитория Create `.agents/plugins/marketplace.json`, Modify `.claude-plugin/marketplace.json`,
`README.md`, `plugins/{selectel-ops,typescript-native-lsp}/README.md`.

**Interfaces:**
- Consumes: готовые `dist/server.js`, `dist/hook.js`, новый `dist/configure.js` и контракты Tasks 2–6.
- Produces: Codex compatibility manifest `name=apple-notes-folder`, `version=2.0.0`, `mcpServers=./.mcp.json`, `skills=./skills/`, `hooks=./hooks/codex.json`, `extensions.com.openai.onboardingSkill=./skills/setup/SKILL.md`, interface с displayName/shortDescription и квадратным SVG для logo/composerIcon.
- `.mcp.json`: `mcpServers.apple-notes-folder` со stdio command `node`, args `${PLUGIN_ROOT}/dist/server.js`, `--client`, `codex`. Не переносить Claude `${user_config.folder}` в Codex.
- Claude manifest: текущий userConfig/env сохранены, args server дополняются `--client claude`, hooks явно `./hooks/claude.json`. В host-hook-файлах команды ведут в один `dist/hook.js --client <host>` с корректным root-placeholder своего клиента. PreToolUse: shell guard и точные имена своих трёх пишущих MCP-tools; UserPromptSubmit: ссылки подтверждённых вложений. Формы manifest/hooks валидируются реальными клиентами, не только JSON.parse.
- `VERSION='2.0.0'` экспортируется `src/version.ts`; package-lock root version, package, server и обе marketplace-записи согласованы. Esbuild entryPoints `{server:'src/server.ts',hook:'src/hook-cli.ts',configure:'src/configure-cli.ts'}`; ровно три bundle-файла.
- Codex каталог: name `yarikmix-plugins`, source `./plugins/apple-notes-folder`, category `Productivity`, policy `{installation:'AVAILABLE',authentication:'ON_INSTALL'}`. Auth аккаунта не добавлять: локальная настройка папки не является OAuth.

- [ ] **Step 1: Написать RED-тесты упаковки.** `test/packaging.test.ts` читает корень через `new URL('../../../', import.meta.url)`, проверяет реальные относительные ссылки после копирования всего plugin-dir в temp-cache. Assertions:

```ts
expect(versions).toEqual(['2.0.0', '2.0.0', '2.0.0', '2.0.0', '2.0.0', '2.0.0', '2.0.0', '2.0.0']);
expect(claudeManifest.userConfig.folder.required).toBe(true);
expect(codexCatalog.plugins.map(p => p.name)).toEqual(['apple-notes-folder']);
expect(claudeCatalog.plugins.map(p => p.name)).toEqual(['typescript-native-lsp', 'selectel-ops', 'apple-notes-folder']);
expect(bundledFiles.sort()).toEqual(['configure.js', 'hook.js', 'server.js']);
expect(codexMcpArgs.slice(-2)).toEqual(['--client', 'codex']);
```

Проверить обнаружение setup-скилла из cache-копии, существование hook/icon/entrypoint, отсутствие symlink в skills, явные разные hooks, отсутствие автоподключаемого чужого `hooks/hooks.json`. Записи Selectel/LSP сравнить с сохранённой базой по поведению, а не менять вместе с новой записью. Версии массива: package.version, lock.version, lock.packages[''].version, server VERSION, Claude manifest, Codex manifest, обе marketplace-записи — восемь значений.
- [ ] **Step 2: Запустить RED.** `npm test -- test/packaging.test.ts`; FAIL отсутствующих manifests и версии.
- [ ] **Step 3: Реализовать упаковку и setup.** Создать простой собственный SVG ≥48×48 без новых генераторов. Setup-скилл спрашивает имя одной папки, запускает bundled configure с одним argv-значением, сообщает о перезапуске; не угадывает имя из заметки и не пишет вручную config клиента. Фронтматтер name `setup`, описание сразу говорит о настройке Apple Notes именно в Codex. Если общий skills-каталог обнаружен Claude, скилл направляет к Claude configure и не меняет Codex-настройку. Зависимости и lock resolutions не обновлять; поменять только версию package/root lock. Сборка детерминирована, без встроенных временных/пользовательских путей.
- [ ] **Step 4: Обновить действующую документацию в той же задаче.** Корневой заголовок `agent-utils`; команды `claude plugin marketplace add YarikMix/agent-utils` и `codex plugin marketplace add YarikMix/agent-utils`, установка `apple-notes-folder@yarikmix-plugins`, независимая настройка, stricter images в 2.0.0 и текущая матрица локальных клиентов. Исторические docs/superpowers не менять, README Selectel/LSP заменить только актуальный URL. Указать, что добавление каталога ещё не устанавливает плагин.
- [ ] **Step 5: Проверить GREEN.** `npm test`, `npm run typecheck`, `npm run verify-build`; последняя печатает `dist совпадает со сборкой из исходников: файлов 3`. В изолированных конфигурациях обоих клиентов проверить установку локального каталога без Node dependencies в cache. Для Claude допустимо отсутствие логина при проверке одной установки; это не засчитывается как живой setup/image-тест. Проверить список обнаруженных скиллов, а не только наличие файла. Реальный прогон setup — в Task 8.
- [ ] **Step 6: Commit.** Добавить только перечисленные manifests/catalogs/setup/docs/build и три dist-файла, исключив fixtures/runtime/cache; `git commit -m 'feat(apple-notes): package Claude and Codex marketplace installs'`.

## Task 8: Живая приёмка установленных плагинов и миграция URL

**Files:** Modify `scripts/live-check.mjs`; Create корневой
`docs/superpowers/research/2026-10-15-apple-notes-acceptance.md`.

**Interfaces:**
- Consumes: установочные артефакты Task 7, вся матрица приёмки спеки, текущие client versions, собственные synthetic fixtures.
- Produces: обновлённый серверный live-check и отчёт с версиями, source/ref/SHA, сырым числом проверок и результатом каждого сценария в каждом клиенте. Приёмка маркетплейса и setup выполняется через настоящие клиенты; прямой MCP live-check проверяет только общий сервер.
- `scripts/live-check.mjs --client claude|codex` выбирает явный host и temp-config/runtime; его картинки получают тестовый допуск через тот же issueTicket и синтетическое подтверждение. Чтобы Node 20 не импортировал TypeScript, live-check собирает `src/attachments/tickets.ts` esbuild-ом в закрытый временный `.mjs` bundle с теми же общими buildOptions/banner и импортирует через file-URL; helper удаляется в finally и не попадает в dist. В отчёте канал помечен server-only: он не доказывает происхождение вложения в клиенте.

- [ ] **Step 1: Обновить server-only live-check.** Сохранить текущую последовательность создания, ожидания и удаления тестовых папок. Убрать зависимость от CLAUDE tmp-корня и безусловного image-path. Все текстовые сценарии, чужие папки, подпапки, списки/вложения, один видимый PNG и отказ неправильному билету проверяются через собранный сервер. До запуска предупредить о временных папках iCloud и остатках удалённых заметок на 30 дней. Не запускать замер на реальной большой папке без необходимости.
- [ ] **Step 2: Выполнить server-only проверку.** `npm run live-check -- --client claude`, затем `npm run live-check -- --client codex`; ожидается отсутствие FAIL, сырые N проверок и отсутствие оставшихся тестовых папок. При ошибке cleanup сохранить список своих тестовых id для удаления; реальные папки не трогать.
- [ ] **Step 3: Проверить установку из локального каталога обоих клиентов.** Использовать авторизованные свежие клиентские диалоги и локальный marketplace source текущего worktree. Изолированный конфиг без логина годится лишь для копирования пакета; нельзя переносить токены/Keychain/env ради авторизации. В рабочем профиле сначала снять закрытую резервную копию настроек, не печатая содержимое. Доверие новым hooks подтвердить штатно. Codex CLI поддерживает `codex plugin add apple-notes-folder@yarikmix-plugins`; Claude — `claude plugin install apple-notes-folder@yarikmix-plugins`. Сохранить имя/URL прежнего source до временной замены, затем восстановить точечно.
- [ ] **Step 4: Проверить запись пользовательской настройки.** Вызвать обнаруженный `$apple-notes-folder:setup` в Codex; выбрать собственную тестовую папку. В Claude настроить другую через прежний configure. На отложенных именах тестовых папок, которых нет в тексте скилла, проверить: скилл спрашивает недостающее имя, не выбирает папку из процитированной заметки и сохраняет только явно названное пользователем значение. Зафиксировать обнаружение именно plugin-скилла в свежем процессе, а не глобальной копии с тем же именем.
- [ ] **Step 5: Пройти всю клиентскую матрицу спеки.** В каждом клиенте выполнить семь notes-tools в своей тестовой папке; отказ чужой папке/подпапке; успешную запись прикреплённого synthetic PNG, вложение предыдущего сообщения; отказ файлу во временном каталоге без вложения; отказ чужому параллельному диалогу; неизвестный контекст оставляет текст рабочим. В Notes проверить видимость одной исправной картинки в собственной синтетической заметке; при GUI соблюдать computer-use-скилл, предупредить об окне и не снимать чужие заметки. Через установленный доверенный хук получить отказ прямой команде чтения метаданных только своей тестовой папки, в Codex также из Code Mode. Проверить readonly/destructive-пометки и сохранность заметки со списком/вложением. Источники изображений должны быть реальными user-message attachment клиента, не ticket, изготовленный live-check.
- [ ] **Step 6: Проверить обновление и сохранение чужой конфигурации.** Создать в изолированных config-root настройку от 1.1.0 и установить 2.0.0; для Codex повторно установить из новой cache-копии с сохранённым config.json, выбрать другую тестовую папку в одном клиенте, перезапустить MCP. Убедиться, что второй клиент сохраняет прежний выбор. Сравнить имена MCP, чужие записи плагинов и число `# ai-launcher-managed` до/после; значения env не печатать. Если marketplace CLI переписывает файл с потерей пометок, восстановить только утраченные метаданные из резервной копии, проверить TOML и продолжить точечным способом, не `codex mcp`. После прогона восстановить прежние пользовательские папки.
- [ ] **Step 7: Проверить Git source, не выдавая локальный каталог за Git-проверку.** Подготовить проверяемый commit/ветку. После разрешённой доставки ветки в GitHub установить через `YarikMix/agent-utils` с ref этой ветки и записать SHA, затем проверить cache и хотя бы один пользовательский image-вызов обоих клиентов. До этого результат обозначается только local-marketplace. Не публиковать или сливать main на основании одного плана. Прежнее разрешение на rename не является разрешением на merge.
- [ ] **Step 8: Обновить remote и завершить отчёт.** По отдельной операции миграции URLs получить fetch/push remote командой `git remote get-url` через subprocess с захватом вывода в памяти, без чтения `.git/config` и без предварительной печати URL. Допускаются только известные публичные SSH/HTTPS формы GitHub для этого репозитория без credentials; при неожиданном URL остановить именно эту операцию, не раскрывая строку. Выполнить `git remote set-url origin <тот же транспорт с YarikMix/agent-utils>`; отдельный push URL, если был, мигрировать отдельно. Основной checkout/worktree-пути не переименовывать. Отчёт: версии, branch/SHA, local/Git source отдельно, счётчики PASS/FAIL, доказательства реального PNG и штатного hook trust, остатки тестовых данных и ограничения. Полный PASS допустим только после всех обязательных сценариев спеки.
- [ ] **Step 9: Финальная проверка и commit.** `npm test`, `npm run typecheck`, `npm run verify-build`, затем `git diff --check`; ожидается PASS и воспроизводимые три bundle-файла. Commit только live-check и обезличенный acceptance-report: `git commit -m 'test(apple-notes): verify installed Claude and Codex plugins'`. Новые дефекты исправлять тестом в задаче владельца и повторять только затронутую приёмку.

## Самопроверка плана и передача в исполнение

Соответствие спеке: архитектура/ограничения — Tasks 2–6; исходные rationale —
Global Constraints и Task 6; папка/ошибки — Tasks 2/6; происхождение и исходные
байты — Tasks 1/3; ticket/copy/TOCTOU — Task 4; хук/Code Mode/trust — Tasks 1/5/8;
каталоги/версия/документация — Task 7; все строки клиентской матрицы — Task 8.
Пять Review Focus закреплены тестами или конкретным сравнением конфигурации.

Перед исполнением перечитать и спеку, и план. Если Task 1 не проходит,
последующие задачи не начинать: сначала представить подтверждённое ограничение
и исправленный дизайн. Если клиент меняет raw-контракт, фикстура не должна
превращать догадку в поддержку. Не объявлять работу выполненной при одних
отказах картинок или одной установке без обнаруженного скилла/хука.

Рекомендуемый метод — **subagent-driven**: восемь задач имеют общие интерфейсы
контекста, билетов и записи, а ошибка в этих границах может дать доступ
постороннему файлу или изменить заметку. Свежая проверка каждой задачи полезнее
единственного ревью после полной интеграции. До выбора метода и ревью плана
продуктовая реализация не начинается.
