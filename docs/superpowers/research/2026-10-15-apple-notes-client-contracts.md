# Контракты клиентов Apple Notes: Task 1

Дата: 2026-10-16. Claude Code **2.1.300**, Codex CLI **0.162.1**. **Gate не пройден; перед Task 2 требуется завершить исследование и вернуться к ревью спеки.** Production src/manifest не менялись.

## Подтверждённые результаты

| Проверка | Claude 2.1.300 | Codex 0.162.1 |
|---|---|---|
| Приём синтетического PNG | Image-блок принят, user replay получен | Диалог остановлен на folder trust |
| Реальный UserPromptSubmit | Получен | Не наблюдался |
| PreToolUse / session-transcript binding | Не проверено | Не проверено |
| Исходные байты после замены source PNG | Не проверено | Не проверено |
| updatedInput ticket получен сервером | Не проверено | Не проверено |
| Скрытый href из additionalContext получен сервером | Не проверено | Не проверено |
| Изоляция planned same-key упаковки при старте | **PASS: только host=claude** | Не проверено |
| Guard shell / Code Mode | Не проверено / неприменимо | Не проверено / не проверено |

`false` в verifier означает отсутствие требуемого доказательства. Ни auth blocker, ни отсутствие доверия не доказывают несовместимость вложений.

## Окружение и команды

Claude native: `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.300`. Codex standalone: `~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex`.

Отдельный `CLAUDE_CONFIG_DIR` явно не задавался, изолированный auth/config-root не создавался. Inherited env/settings values не читались и не выводились. Вывод об авторизации относится только к фактическим запускам, а не ко всем установкам Claude.

Development-helper `plugins/apple-notes-folder/scripts/probe-host.mjs` не обращается к Notes. Режимы: `prepare --client <claude|codex> --out <root>`, `hook --out <run> --host <host>`, `server --out <run> --host <host>`, `verify --out <root>`.

Из корня проекта:

```sh
node plugins/apple-notes-folder/scripts/probe-host.mjs prepare --client claude --out /private/tmp/apple-notes-contract-same-key-20261016
node plugins/apple-notes-folder/scripts/probe-host.mjs prepare --client codex --out /private/tmp/apple-notes-contract-same-key-20261016
node plugins/apple-notes-folder/scripts/probe-host.mjs verify --out /private/tmp/apple-notes-contract-same-key-20261016
```

Команды выше показывают воспроизводимую итоговую подготовку. Фактический Codex trust-запуск был в предыдущем диагностическом root `/private/tmp/apple-notes-contract-20261016/codex`, same-key Codex ещё не запускался. `prepare` создаёт `<out>/<client>` с каталогами 0700, файлами 0600 и отказывается повторно использовать существующий client-каталог. Синтетический PNG 1×1 взят из `scripts/live-check.mjs`. Сырые события остаются только в закрытом scratch.

Фактический Claude same-key запуск, cwd `/private/tmp/apple-notes-contract-same-key-20261016/claude`:

```sh
umask 077
claude -p --plugin-dir /private/tmp/apple-notes-contract-same-key-20261016/claude/plugins/attachment-contract-probe --input-format stream-json --output-format stream-json --verbose --replay-user-messages < /private/tmp/apple-notes-contract-same-key-20261016/claude/claude-input.json > /private/tmp/apple-notes-contract-same-key-20261016/claude/client-output.jsonl 2> /private/tmp/apple-notes-contract-same-key-20261016/claude/client-stderr.txt
```

В root `/private/tmp/apple-notes-contract-20261016/codex` выполнен `git init -q`, затем фактически запущено:

```sh
codex --no-daemon --no-alt-screen --cd /private/tmp/apple-notes-contract-20261016/codex --image /private/tmp/apple-notes-contract-20261016/codex/image.png 'Synthetic client-contract probe. Call probe_attachment once with marker before and markdown baseline. Do not include attachment_ticket. Do not use other tools or read files.'
```

CLI остановился на `Folder access` → `Trust this folder?`, `Your trust decision will be saved.`, `1. Trust and continue`, `2. Quit`. Trust не подтверждался; Escape завершил CLI с exit 0. Для продолжения требуется явное разрешение пользователя на native folder trust выбранного scratch-root. Возможный следующий `Hooks need review` ещё **не наблюдался**; его надо сначала увидеть и показать пользователю. Не использовались bypass, глобальная установка, изменение профилей или `codex mcp add/remove`.

## Упаковка: разные ключи и точный same-key вариант

Первоначальный диагностический probe использовал разные MCP-имена `probe-claude` и `probe-codex`. Claude действительно стартовал оба: inline MCP и root `.mcp.json`. Это наблюдение означает co-loading для разных ключей; **оно не доказывает несовместимость planned same-key раскладки**.

Контроллер уточнил, что оба final manifests должны использовать одинаковый ключ `apple-notes-folder`. В отдельном throwaway same-key probe оба ключа заменены на него, а аргументы server `--host claude` / `--host codex` и folder-marker оставлены различными. Результат:

```json
{"name":"plugin:attachment-contract-probe:apple-notes-folder","status":"connected","source":"plugin"}
```

Реальный сервер записал только `server-start.host=claude`, затем `server-initialized.clientInfo.version=2.1.300`. host=codex не запускался. Inline Claude определение имеет правильный приоритет над root `.mcp.json` для одинакового ключа. Итоговый helper использует именно этот ключ в обоих файлах. `packagingIsolation=true` подтверждено для старта Claude, остальные capability-поля остаются false.

Также по разрешению контроллера проверен throwaway split-root `/private/tmp/apple-notes-contract-split-20261016/claude`: `.codex-plugin/` и root `.mcp.json` перенесены в соседний `codex-install-root/`. Та же Claude-команда с этим root дала только host=claude. Это вспомогательное наблюдение, а не необходимое исправление planned same-key схемы. Продуктовая раскладка не изменена.

## Реальные поля и момент доступности байтов

`test/fixtures/hosts/claude.json` содержит обезличенный **реальный** same-key `UserPromptSubmit`. Поля: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode: "auto"`, `hook_event_name: "UserPromptSubmit"`, `prompt` (только собственный синтетический текст). Пути/идентификаторы заменены фиктивными; поля не придуманы.

В payload нет image/base64. При этом hook-вызове `transcript_path` дал `ENOENT`; `transcriptRecords=[]`, `preToolUse=null` честно отражают отсутствие наблюдения. User replay image-блока доступен stdout, но не доказывает его доступность production hook. Поздняя доступность исходных байтов и их сохранность после замены PNG пока не проверены. Helper принимает только inline bytes в пользовательских transcript records; assistant images и позднее чтение `localImage.path` не учитываются.

Claude-модельный вызов завершился exit 1 с сообщением: `Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access`. Это auth blocker. Провайдерские настройки и ключи не читались, не копировались и не менялись.

Codex fixture намеренно не создан: реальных Codex hook/transcript-событий нет. Генерация схемы `codex app-server generate-json-schema --experimental --out /private/tmp/apple-notes-codex-schema` прошла, но схема `localImage.path` не является реальным событием и доказательством исходных байтов.

## Продолжение после устранения blockers

1. Повторить свежий Claude image-запуск в штатно авторизованном provider-контуре; не копировать ключи и не обходить политики организации.
2. После разрешения пользователя подтвердить native Codex folder trust для выбранного scratch-root. Отдельный hook-review сначала наблюдать и согласовать. Повторить с итоговым same-key helper.
3. Начать с `controls.json` `{ "rewrite": false, "mutateOnSubmit": false }`, marker `before`. Получить реальный server-call без ticket; verifier обязан вернуть `rewriteReceived=false`, exit 1. Пока такой negative control не снят.
4. Только в scratch включить `rewrite: true`; свежему image-запросу задать marker `after`, без ticket и скрытого href. Доказать input без ticket → hook updatedInput `probe-v1` → серверный `probe-v1`, а также hidden href из additionalContext в server markdown.
5. В отдельном свежем прогоне `mutateOnSubmit: true` заменяет свой PNG при получении сообщения hook-интеграцией. Старые байты должны оставаться в host payload/transcript либо иметь ранний hash/snapshot. Предварительная тестовая копия и поздний path/hash недостаточны. Поддерживаемый helper разбор transcript нужно сверить с реальными событиями.
6. Попросить обычный shell выполнить точное содержимое `guard-command.txt`, Codex Code Mode — `code-guard-command.txt`. Проверить hook deny и отсутствие эффектов. Helper принимает в качестве Code Mode evidence только outer `exec`/`functions.exec` с `tools.exec_command(`; это ожидаемый, ещё **не подтверждённый** на Codex формат. Иной формат требует наблюдения, не ослабления проверки.
7. Verifier требует два отчёта, все capability-поля, отдельный `negativeControl`; читает только события, не ответ модели. Сохранить обезличенные реальные fixtures обоих клиентов и пройти gate до Task 2.

## Проверки

`npm ci` с private scratch cache и разрешённой сетью: PASS (исходный sandbox ENOTFOUND не засчитан). `npm test`: 108/108; typecheck и verify-build PASS. Focused `node --test scripts/probe-host.test.mjs`: 4/4. Helper tests используют явно синтетические записи и не подменяют host fixtures. Verifier на неполных реальных данных возвращает ожидаемый exit 1.

Официальные [правила упаковки OpenAI](https://developers.openai.com/plugins/build/plugins) и [hooks](https://learn.chatgpt.com/docs/hooks) использовались для подготовки probe, а не вместо фактического gate.
