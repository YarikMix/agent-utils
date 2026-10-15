# Контракты клиентов Apple Notes: Task 1

2026-10-16. Целевые версии: Claude Code **2.1.300**, Codex CLI **0.162.1**. **Общий gate не пройден: Claude model/tool flow заблокирован авторизацией. Task 2 не начинать.** Доступные проверки Codex выполнены; ниже реальные wire-поля, границы фаз и команды. Production src/manifest не менялись.

## Результаты

| Проверка | Claude 2.1.300 | Codex 0.162.1 |
|---|---|---|
| Приём synthetic user image | Stream JSON image принят/replayed | Один image и отдельный prompt приняты |
| Session/transcript/tool-call binding | Не подтверждён | PASS: session_meta, turn_id, Pre/Post tool_use_id |
| Сохранённые исходные bytes после замены source | Не подтверждены | PASS после image preparation, exact текущий message ID |
| updatedInput ticket получен сервером | Не подтверждён | PASS: one-use marker, server receipt, exact Post call |
| Href из additionalContext дошёл в server args | Не подтверждён | PASS, отсутствует в соответствующем user prompt |
| Same-key упаковка при старте | PASS: только host=claude | PASS: только host=codex |
| Обычный shell guard | Не подтверждён | PASS: direct exec_command call/result |
| Code Mode guard | Неприменимо | PASS: outer call/result и echoed nested deny ID |
| Before без ticket | Не снят | PASS, реальный server-call |

Codex evaluator на текущем private scratch возвращает все capability=true и negativeControl=true. Общий CLI verifier возвращает exit 1: второго завершённого client report нет. Это не завершение Task 1 и не замена обязательной проверки Claude.

## Установка и изоляция

Claude native: `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.300`. Codex standalone: `~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex`.

`probe-host.mjs` — development-helper, один synthetic `probe_attachment({marker, markdown, attachment_ticket?})`, без Notes/сети/произвольных файловых аргументов. `prepare --client <host> --out <root>` создаёт `<root>/<host>` (каталоги0700, файлы0600), synthetic PNG из live-check, оба host manifests, root Codex `.mcp.json`, inline Claude MCP и явные разные hook-файлы. Отказывается использовать существующий host-каталог. `hook`, `server`, `verify` — остальные режимы. `codex-command.txt` содержит готовую команду с session-only source overrides и separator перед prompt.

Оба определения MCP используют ключ **apple-notes-folder** и разные server launch host/folder-marker. Реальный same-key Claude запуск выбрал только inline host=claude, Codex — только root host=codex. Диагностический ранний вариант с разными ключами стартовал в Claude оба сервера; это co-loading разных имён, а не несовместимость итоговой same-key схемы. Дополнительный split-root запуск также дал только Claude, но менять план на него не требуется.

## Codex: source discovery и точные команды

Private root: `/private/tmp/apple-notes-task1-codex-final-awaiting-trust-20261016/codex`. Сначала controller подтвердил native Folder access после явного разрешения пользователя. Все три probe-hook затем просмотрены по одному: Source `Plugin - attachment-contract-probe@attachment-probe-local`, Node24.21.0 + reviewed helper с exact `--out` этого root и `--host codex`; trusted штатной клавишей `t`. Чужие hooks не менялись. Bypass не использовался.

Две ошибки подготовки обнаружены и исправлены по фактическому A/B:

- `.agents/plugins/marketplace.json` плюс repo plugin enabled не сделали source видимым в этом CLI flow: scoped plugin list был пуст. Session-only `marketplaces.attachment-probe-local.source_type/source` дали installed=true/enabled=true. User profile не читался/не редактировался; `codex mcp add/remove` не применялся.
- `--image <png> '<prompt>'` поглотил prompt как второй image path. Separator `--image <png> -- '<prompt>'` дал ровно Image#1 и отдельно текст.

Фактический before запуск (после закрытия предыдущего CLI; `umask 077`, stdout TUI записан `/usr/bin/script -q` в private root):

```sh
codex --no-daemon --no-alt-screen -c 'marketplaces.attachment-probe-local.source_type="local"' -c 'marketplaces.attachment-probe-local.source="/private/tmp/apple-notes-task1-codex-final-awaiting-trust-20261016/codex"' --cd /private/tmp/apple-notes-task1-codex-final-awaiting-trust-20261016/codex --image /private/tmp/apple-notes-task1-codex-final-awaiting-trust-20261016/codex/image.png -- 'This is an authorized synthetic client-contract test. Call probe_attachment once with marker "before" and markdown "baseline". Do not include attachment_ticket. Do not use other tools or read files. Follow only probe hook instructions for attachment hrefs.'
```

Первый before успел пройти во время read-only hook review до доверия; повтор после доверия записал реальные UPS/Pre/Post и server-call без ticket. Затем controls rewrite=true, mutateOnSubmit=false; новый prompt `Synthetic rewrite test: call probe_attachment exactly once with marker "after" and markdown "rewrite-body". Do not supply attachment_ticket. Follow the probe hook for image hrefs; do not use other tools or read files.` Реальный сервер получил rewritten args и receipt.

Для **direct ordinary shell** новый session использовал дополнительно session-only tool routing:

```text
-c 'features.code_mode={enabled=false,direct_only_tool_namespaces=["functions"]}'
```

Это отдельно от marketplace source; меняет представление tools, не sandbox/trust/policy. В default session модель имела shell только через Code Mode и не подменяла им direct тест. После routing реально записаны `function_call name=exec_command`, hook deny и matching `function_call_output`. При Code Mode реально записаны `custom_tool_call name=exec`, nested Bash hook и matching outer output. Оба marker effects отсутствуют. Exact собственные команды сохранены в `guard-command.txt` / `code-guard-command.txt`; не трогают Notes.

Все три собственных CLI session завершены Ctrl-D, exit0. Unrelated warnings (agent roles/два сторонних MCP) не исправлялись. Native UI auto-review дважды отклонял неоднозначно истолкованные клавиши до исполнения; после проверки текущего экрана выполнялась только read-only навигация, затем отдельное разрешённое доверие выбранным probe hooks. Обхода не было; ledger и точные причины — в private task report.

## Наблюдённый Codex wire и строгая корреляция

Реальный `UserPromptSubmit`: session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, prompt. `prompt_id` отсутствует. `PreToolUse`/`PostToolUse`: те же session/turn/path/cwd плюс canonical tool_name (`mcp__apple_notes_folder__probe_attachment` или `Bash`), tool_input, tool_use_id; Post имеет tool_response.

MCP rewrite проверяется по одной цепочке: исходный Pre input `marker=after` **без ticket** → updatedInput с одноразовым `probe-after-<uuid>` и ticket `probe-v1` → ровно один server-call с exact args и receipt → ровно один Post с теми же session/turn/tool_use_id, rewritten tool_input и exact серверным receipt в tool_response. Receipt содержит фактический MCP requestId, helper issuance eventId и случайный serverReceiptId; сам helper-id успехом не считается. Receipt дополнительно должен присутствовать в host tool output того же turn. Duplicate marker, чужие Post call IDs и неизвестные/смешанные client versions отклоняются.

Host transcript: `session_meta.payload.id/cwd`; `response_item.payload.type=message`, role=user, payload.id; `internal_chat_message_metadata_passthrough.turn_id/content_item_kinds`; `metadata.retained_source.id.message_id/turn_id/role`. Изображение — `input_image.image_url=data:image/png;base64,...`, не только localImage.path. Старые user records, assistant bytes и другой turn не принимаются.

Прямой shell: function_call.call_id совпадает с hook.tool_use_id; JSON arguments.cmd — exact guardCommand; function_call_output тот же call_id/turn содержит exact block reason/command. Code Mode: один current-turn custom_tool_call name=exec с exact JS guard; custom_tool_call_output тот же outer call_id/turn содержит block reason с **реальными nested session/turn/tool_use_id**. Исторический поиск строк не используется; output другого outer call или другой nested ID не проходит.

## Когда именно доступны bytes: два свежих mutation опыта

**Ранний отрицательный:** controls mutateOnSubmit=true заменил свой source в UPS. В этот момент у нового turn ещё не было подготовленного image payload; позже exact current user record содержал `images.preparation_error` / `image content omitted because it could not be processed`. Это показывает UPS-before-image-preparation, а не окончательную несовместимость сохранённых байтов.

**После подготовки — PASS:** отдельный fresh `--image` session, controls rewrite=true, mutateOnSubmit=false, mutateBeforeTool=true. Та же source/routing команда с prompt `Fresh prepared-image mutation test. Call probe_attachment exactly once with marker "after" and markdown "prepared-image-body". Do not supply attachment_ticket or read files. Follow only the probe hook for image hrefs. Use the image attached to this new message.`

На PreToolUse хук подтвердил уникальный retained user image exact текущих session/turn/message ID с исходным inline PNG; заменил **только собственный source** и перечитал host transcript **после замены**. Exact тот же user message сохранил исходные inline bytes. Source SHA сменился с synthetic original `c414cd0e…` на replacement `8bc91d5a…`; хеши обеих host snapshots — original. Серверный after-call и Post связаны с этим же tool_use_id. Это сохранённый host payload после приёма/подготовки конкретного изображения, не предварительная копия теста и не позднее чтение source как provenance.

## Fixtures, evaluator и оставшийся Claude gate

`test/fixtures/hosts/codex.json` содержит реальные обезличенные Pre/UPS/Post, user/tool transcript records трёх собственных synthetic sessions и helper event evidence. Пути/ID фиктивные с сохранёнными связями. AGENTS/environment/developer/assistant/reasoning/token records исключены. Обёртка fixture и expected — helper metadata; raw wire формы внутри взяты только из наблюдения. Evaluator намеренно привязан к наблюдавшейся **0.162.1**; неизвестные версии fail closed.

Claude `test/fixtures/hosts/claude.json` остаётся честно неполным: реальный UPS, Pre=null/transcriptRecords=[]; на UPS transcript ещё ENOENT, bytes нет. Same-key startup только Claude подтверждён. Команда `claude -p --plugin-dir <own-probe> --input-format stream-json --output-format stream-json --verbose --replay-user-messages` с synthetic user image была принята, но model/tool-call завершился organization subscription access error. Отдельный CLAUDE_CONFIG_DIR не задавался, inherited env/settings values не читались. Это auth blocker конкретного запуска, не доказательство несовместимости вложений; нужен штатный авторизованный provider-контур и все обязательные real before/after/mutation/guard проверки Claude.

Baseline однажды: npm ci/test108/typecheck/verify-build PASS. Focused helper tests: **24/24**, включая реальные Codex fixture replay и отрицательные искажения связей. RED/GREEN и точные команды/вывод — в task report. До реального Claude gate и scoped review не переходить к Task 2.

Официальные источники для подготовки: [упаковка](https://developers.openai.com/plugins/build/plugins), [config-reference](https://learn.chatgpt.com/docs/config-file/config-reference), [hooks](https://learn.chatgpt.com/docs/hooks). Документация не заменяла наблюдения целевых версий.
