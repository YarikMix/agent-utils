# Apple Notes 2.0.0 — приёмка Claude Code и Codex

**Codex CLI 0.163.0: 20/20 PASS, включая видимую исправную PNG в Notes.**
Финальная приёмка выполнена 16.10.2026 после reviewed native исправления
`f8ac66e`, базы изолированного diff Task8. Исторический GUI FAIL на 0.162.1
сохранён ниже и не включён в положительный итог текущего прогона.

Применено [согласованное уточнение Claude без аккаунта](../specs/2026-10-16-apple-notes-claude-unavailable-amendment.md):
Claude model/tool/setup/image — **NOT RUN**, аккаунта нет. Git-source установка —
**NOT RUN**, публикация ветки не разрешена. Общий двухклиентский live PASS не заявляется.

## Окружение и установка

macOS 26.5.2; Node 24.21.0; Claude Code 2.1.300. Codex обновился внешним образом
с 0.162.1 до 0.163.0; Task8 не менял бинарник, PATH или авторизацию.
Пакет `apple-notes-folder@yarikmix-plugins` версии 2.0.0 содержит три готовых
bundle и запускается из установленного cache без node_modules/npm/build.

Проверен **local-marketplace** текущего worktree. Настоящий auth-free CLI
установил пакет в изолированный профиль; после удаления source настоящий
Codex 0.163.0 app-server запустил serverInfo 2.0.0, toolsError null и семь tools.
Упаковочный host-test разрешает только проверенные 0.162.1 и 0.163.0; неизвестные
версии пропускают только этот тест. Task1 probe verifier остаётся pinned 0.162.1.
Наблюдённые структуры 0.163.0 дополнительно воспроизводятся отдельной
обезличенной actual-derived fixture через production-адаптер: точные исходные
bytes, известный служебный текст без attachment grant. Недостающие поля не придуманы.

Живой Codex использовал обычный авторизованный аккаунт, project-enabled plugin
из собственного scratch marketplace и runtime cache. Глобальная запись установки
или включения не добавлялась; credentials не переносились. Reviewed source/cache
сверены побайтно. Native folder trust и ровно три production hooks ранее приняты
индивидуально после проверки Source/Command; чужие hooks не подтверждались.

## Реальные сценарии Codex 0.163.0

Счётчик отражает отдельные assertions по фактическим эффектам и ответам.

| Сценарий | Итог |
|---|---|
| notes_create: текст и жирное оформление | PASS |
| notes_list: своя заметка, без внешней папки/подпапки | PASS |
| notes_read: исходный текст | PASS |
| notes_search: найден нужный ID | PASS |
| notes_append: исходный и новый текст сохранены | PASS |
| notes_update: текст заменён и перечитан | PASS |
| notes_delete: deleted true, затем ID недоступен | PASS |
| Внешняя синтетическая папка: read/append/update/delete, сохранность | PASS, 4 отказа MCP |
| Синтетическая подпапка: те же операции и сохранность | PASS, 4 отказа MCP |
| Список: append/update запрещены, оба пункта сохранены | PASS |
| Настоящий PNG: сохранённые исходные bytes после замены своего файла, hook rewrite | PASS |
| PNG предыдущего сообщения того же диалога без нового вложения | PASS |
| Картинка: append/update запрещены, исходное вложение сохранено | PASS |
| Href изображения другого параллельного диалога | PASS, отказ до записи |
| Существующий temp PNG без прикрепления; текст продолжает работать | PASS |
| Controlled unknown context: картинка отклонена, текст работает, transcript восстановлен | PASS |
| Доверенный guard: прямой exec_command | PASS |
| Доверенный guard: вложенный Code Mode exec_command | PASS |
| Setup: недостающее имя/цитата не выбирают папку, явный выбор сохранён | PASS |
| Одна исправная PNG в отдельном собственном окне Notes; окно закрыто | PASS |

Исходное настоящее вложение принято в READY-only turn; проверены inline bytes
и identity собственного transcript. Пока диалог был idle, заменён только свой
source PNG. Последующий реальный create использовал сохранённый attachment href;
source восстановлен в finally. Тело Notes и официальный Notes.save экспорт
содержат исходные 349 байт, отличающиеся от replacement. Второй create в том же
диалоге без нового вложения дал те же bytes в теле и экспорте. SHA256 в обоих:
`2f1c46b0c01c840bc20065e94517511b2de3ab7b1137c4d9eb3389b0758656a2`.
В model calls нет attachment_ticket; фактические MCP args содержат добавленный
доверенным хуком ticket. Отдельный снимок точного собственного окна показывает
одну синюю с золотым PNG 128×96 под подписью; точное окно закрыто сразу после снимка.

Controlled negative — явное изменение 22 байт metadata kind только собственного
реального transcript после READY. Вызов картинки отклонён, поиск вернул ноль,
обычная заметка создана/прочитана/удалена. Восстановлен только исходный substring:
prefix и все 161044 байта настоящего appended tail сохранены, JSONL валиден.
Это контролируемая порча контекста, а не естественно наблюдавшийся новый формат.
Дополнительные исторические два synthetic hook-only negative checks считаются отдельно.

Текущий прогон содержит **40 реальных MCP ответов**: current 2, previous 5,
text/scope/list 25, temp 4, controlled 4. Отказов автоматического согласования — 0.
Три image-вызова остановлены PreToolUse до MCP; два shell-guard вызова учитываются
отдельно. У обоих guards проверены точная команда, direct/Code Mode, общий call ID
и наблюдённый turn ID во вложенной metadata вызова/ответа.

## Server-only и конфигурация

```sh
# cwd: plugins/apple-notes-folder
npm run live-check -- --client claude
npm run live-check -- --client codex
```

После общего native исправления оба host повторно прошли по **50/50**, итого
**100 PASS, 0 FAIL**. Критерий картинки усилен: ровно один attachment/img и
декодированные PNG bytes равны fixture; `(null)` больше не даёт ложный PASS.
Проверены семь tools и annotations, текст, границы папок, неверный/отсутствующий
билет, списки/вложения, ошибки настройки, cleanup после ожидания iCloud.
Это программно выданные synthetic tickets, **не доказательство client provenance**.
Временный ESM helper собирается общими esbuild options/banner и удаляется
в finally вместе с собственными temp config/runtime. Cleanup удаляет только
записанные созданные IDs после проверки title/container и только известные
пустые папки; неожиданные активные члены сохраняются. Большую реальную папку
и benchmark не запускали.

Ранее выполненные auth-free upgrade/preservation — **17/17 PASS**: настоящий
Claude CLI установил историческую 1.1.0, сохранил тестовый userConfig и обновил
до 2.0.0; чужие disabled plugin и permissions сохранены. Codex config формата 1
пережил установку и переустановку из новой cache-копии. Чужие MCP, plugin entry
и два `# ai-launcher-managed` сохранены. Эти результаты получены до внешнего
обновления Codex и не переименовываются в текущую 0.163.0 upgrade-проверку.

Независимость/перезапуск конфигурации — ещё **10/10 PASS** server-only:
разные папки, прежняя папка у работающего MCP, новая после рестарта, неизменный
второй host, сохранение прежней при ошибке, режимы 0700/0600. Эти 27 проверок
отделены от текущих 20 живых сценариев и автоматического suite.

## История исправлений и финальная проверка

Живая приёмка выявила три дефекта, исправленных владельцами и прошедших review:
`77cd65a` — plugin-relative MCP cwd/argv вместо нерасширенного `${PLUGIN_ROOT}`;
`fdbbaa7` — только известные служебные input_text kinds без ослабления image
identity/bytes; `f8ac66e` — узкая передача проверенных snapshots в Notes перед
HTML импортом. До последнего исправления GUI на 0.162.1 показала пустую картинку,
body содержал `data:image/png;base64,(null)` при правильном runtime snapshot.
Прежние counts-only критерии были ложноположительными: исторический итог
**19 PASS / 1 FAIL**, не PASS. Новые decoded-byte/export/GUI проверки устранили
этот пробел. Native sandbox handoff проверен на текущей macOS; следующая версия
macOS требует новой native/GUI приёмки.

Исторические три auto-review отказа по неизвестным synthetic IDs не считались
серверными отказами; обычный повтор после точечного ownership proof прошёл.
Исторический общий cleanup был остановлен до исполнения и заменён exact-ID
проверками. Текущий прогон обходов отказов не использовал.

Финальный полный suite после изменений Task8: **365/365 PASS, 21 файл,
0 SKIP**. Typecheck — PASS; verify-build — 3 совпавших bundle; diff-check — PASS.
После review I1 setup переведён на пять последовательных native-шагов: до
каждой мутации атомарно записывается закрытое recovery-намерение, сразу после
неё — exact ID. Native catch сохраняет наблюдённую identity; при потере ответа
восстановление ограничено случайным именем своего запуска, записанным parent ID
и marker заметки после preflight отсутствия. При неоднозначности journal и
временный каталог сохраняются, папки-предки не удаляются. Частичный журнал
используется cleanup с теми же identity-проверками. RED воспроизвёл прежнюю
потерю двух ID; focused fault-injection тесты — **18/18 PASS**: ошибка после
каждого создания, потеря каждого ответа, отказ/ошибка/неоднозначность recovery,
несовпадение identity, занятое имя и неожиданные члены. Один targeted Codex
server-only прогон после правки — **50/50 PASS**, journal содержит все 3 папки и
2 заметки, pending отсутствует, cleanup пуст. Реальная матрица 20/20 и GUI
повторно не запускались: production не изменён. Финальный suite 365/365 включает
новые тесты; после него менялись только факты в документации.
Локальный scratch task-6-report исключён из tracked distribution с сохранением
самого файла для review.

## Очистка и ограничения

После GUI удалены пять известных собственных заметок, включая старую битую и
новую исправную; затем четыре известные пустые папки. Проверены exact IDs,
заголовки, container и synthetic body markers. Известные ссылки на удалённых
детей учтены без удаления неизвестных объектов. После задержки iCloud 46.73 с
все четыре папки отсутствуют, пять заметок недоступны в своих исходных папках;
неожиданных активных остатков нет. Server-only папки также отсутствуют.

Исходное отсутствие пользовательского plugin-folder config восстановлено после
проверки собственного значения. Все собственные CLI завершены; точное GUI окно
закрыто. Четыре известных consumed tickets и один synthetic snapshot остаются
в приватном runtime до следующего запуска MCP после истечения 24 часов;
своих active operations 0. Production trigger этой очистки подключён финальным
исправлением ниже.
Evidence и изолированные профили сохранены приватно. Следы удалённых заметок
могут оставаться в «Недавно удалённых» до 30 дней; предупреждение дано до запуска.

Fetch origin мигрирован на публичный `YarikMix/agent-utils` с сохранением SSH
транспорта; эффективный push URL уже соответствовал новому имени. Применён
subprocess capture с allowlist, без чтения `.git/config` и раскрытия неожиданных
URLs. Push/merge не выполнялись.

Точные synthetic IDs, private пути, команды, raw stdout/stderr и счётчики
сохранены в локальном SDD task-8-report.md и закрытом evidence root. Личные пути,
содержимое чужих Notes, credentials и tickets в этот отчёт не включены.

## Финальное исправление обслуживания и разрешений

После whole-branch review production MCP-сервер выполняет GC один раз при
запуске. Просроченные допуски и незащищённые снимки старше 24 часов удаляются;
свежие допуски, активные операции и runtime другого клиента сохраняются.
Ошибка обслуживания выдаёт фиксированную безопасную диагностику, не отключает
текстовые инструменты и не меняет результат завершённой записи Notes. Проверка
исполняет настоящий bundled entrypoint обоих host, включая занятый и повреждённый
lock. Отказ по lock теперь отличим от отказа происхождения; README описывает
ручное восстановление конкретного своего lock после остановки writers.
Неопределённый lock автоматически не удаляется.

**Permission wire различается по клиентам.** Claude получает `updatedInput` без
`permissionDecision`, поэтому проверка картинки не выдаёт разрешение на замену.
В Codex 0.163.0 такой ответ реально не применил rewrite: MCP получил исходные
аргументы без билета и безопасно отказал. Это отрицательное наблюдение сохранено,
а несовместимый вариант не объявлялся рабочим. `ask` также не поддерживается
точной версией; соответствующая диагностика найдена в установленном binary и
подтверждена исходниками. Для Codex оставлен обязательный `allow` только вместе
с `updatedInput`: здесь он разрешает передачу новых аргументов, не саму запись.

Это подтверждено по публичному тегу `openai/codex/rust-v0.163.0`:

- [output_parser.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/engine/output_parser.rs#L162) возвращает `updated_input` и не возвращает состояние approval; [проверка wire](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/engine/output_parser.rs#L442) требует `allow` для rewrite и отклоняет `ask`.
- [hook_runtime.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/hook_runtime.rs#L210) переводит результат в `Continue { updated_input }`; [registry.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/registry.rs#L701) передаёт заменённый invocation обычному обработчику.
- [MCP handler](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/handlers/mcp.rs#L460) меняет только arguments; затем [mcp_tool_call.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/mcp_tool_call.rs#L273) отдельно вызывает штатный `maybe_request_mcp_tool_approval` по policy/annotations, без состояния hook-allow.

Это статическое доказательство сохранения проверки разрешений точной версии,
дополненное реальными вызовами клиента; оно не является заявлением о живом
Claude или показе ручного confirmation в каждом режиме Codex. Доверие к hook
не менялось. Другие версии Codex требуют новой проверки wire и approval.

M1 отложен как неблокирующее ограничение: лимит 10 МБ проверяется после
материализации JSONL record; суммарная память длинного диалога этим лимитом
не ограничена. Тяжёлый OOM stress не запускался, новая parser policy не вводилась.
Claude live и Git-source установка остаются NOT RUN по согласованному дополнению.

После финального изменения source/test: **373/373 PASS, 22 файла, 0 SKIP**;
77/77 focused, typecheck PASS, verify-build **3/3**, diff-check PASS. Первый
sandbox suite дал 372 PASS и timeout существующего теста snapshots из-за
`EMFILE` в `fs.watch`; повтор полного suite в обычном ранее разрешённом окружении
вне sandbox прошёл без изменений теста/таймаута. Сырой неуспешный запуск сохранён.

Узкая повторная приёмка Codex 0.163.0: **5 завершённых MCP-вызовов** — current-image
create/read (2) и same-dialogue plain-text create → previous-image update → read
(3). Три model write calls не содержали ручного ticket; оба image calls получили
билет от hook. В каждой заметке **1 image / 1 attachment / 1 unique attachment**;
349 bytes из body и официального Notes export равны исходному PNG, SHA256
`2f1c46b0c01c840bc20065e94517511b2de3ab7b1137c4d9eb3389b0758656a2`.
Предшествующий отказ выдуманному model href сохранён отдельно. Полная историческая
матрица 20/20 и GUI повторно не запускались: изменились только обслуживание,
диагностика и permission wire, native import не менялся.

Две новые собственные заметки удалены после проверки exact ID/title/container/
marker; затем удалена собственная пустая папка. Исходное отсутствие plugin config
восстановлено после проверки собственного значения. Все CLI завершены; новые
окна GUI не открывались. Отложенная проверка подтвердила отсутствие своей папки
и обеих заметок в исходном container; у двух известных успешных tickets
active markers отсутствуют. Текущие source и разрешённые project/cache копии совпали
по **10/10** проверенным runtime/config файлам; hooks trust не менялся.
