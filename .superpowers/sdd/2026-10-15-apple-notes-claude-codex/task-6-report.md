# Task 6 — MCP integration

Статус: DONE. База: `015ca42`; ownership по brief, включая tickets.ts.

Прочитаны task-6-brief.md с дополнениями, global-constraints.md,
приоритетная поправка 2026-10-16, implementer-prompt. Реальный Claude live
не заявляется; тестовые envelope Claude обозначаются synthetic/documented.
Использован verification-before-completion; все результаты ниже фактические.

## Реализация

- Один сервер выбирает Claude/Codex и один раз читает конфигурацию выбранного
  хоста; readFolder CONFIG сохраняется в getScope, stdio/MCP продолжает отвечать.
  makeScopeProvider сохраняет прежний retry временной ошибки Notes и cache успеха.
- По согласованному с контроллером различию strict parseHost/argv остаётся
  fail-fast: неизвестный клиент не равен ошибке config уже выбранного клиента.
- makeImagePreparer использует consumeTicket и verifySnapshot для каждого grant,
  строит закрытую карту href → проверенный snapshot file URL, без чтения исходного
  произвольного пути. Текст не требует transcript, не потребляет переданный ticket,
  его resolver отклоняет любую попытку загрузить картинку.
- Три write tools принимают attachment_ticket с заданным regex, передают целые args
  ровно один раз; TRUNCATED/IMAGE_REF остаются чистыми проверками до consume.
  Весь Markdown конвертируется до создания NotesService/получения scope.
- release вызывается в finally, включая ошибки конвертации и TIMEOUT_WRITE.
  Ошибка cleanup не заменяет исходный Notes результат; печатается фиксированная
  безопасная stderr-строка без ticket, текста, байтов, путей. Билет не возвращается,
  active/consumed реестр остаётся для консервативной очистки при отказе release.
  Ошибки создания resolver и consume валидации также сохраняют исходную ошибку
  после попытки release.
- FOLDER_GONE в runner принимает host hint, default Claude сохранён.
- Production imageSrc/defaultImageRoot и соответствующий старый допуск файлов
  удалены. Сигнатуры и лимит 10 MiB остаются в images.ts.
- Ровно семь имён и destructive/readOnly annotations сохранены. notes.ts/JXA,
  manifests/versions/dependencies не менялись; версия остаётся 1.1.0 до Task 7.

## TDD evidence

Команды выполнены из plugins/apple-notes-folder.

RED до реализации:

```text
npm test -- test/tools.test.ts test/attachment-integration.test.ts test/server.smoke.test.ts
Test Files  3 failed (3)
Tests       26 failed | 22 passed (48)
exit 1
```

Ожидаемые отказы: makeImagePreparer is not a function; prepareImages не вызван;
в schema нет attachment_ticket; Codex получает Claude hint; malformed config
не отражён как CONFIG. Текстовые старые сценарии проходили.

Первый GREEN:

```text
npm test -- test/tools.test.ts test/attachment-integration.test.ts test/server.smoke.test.ts test/images.test.ts test/runner.test.ts test/errors.test.ts test/scope.test.ts
Test Files  7 passed (7)
Tests       72 passed (72)
exit 0
```

Расширенная focused проверка cleanup failure/lease/resolver и независимости config:

```text
npm test -- test/tools.test.ts test/attachment-integration.test.ts test/server.smoke.test.ts test/images.test.ts test/runner.test.ts test/errors.test.ts test/scope.test.ts
Test Files  7 passed (7)
Tests       81 passed (81)
exit 0
npm run typecheck
> tsc --noEmit
exit 0
```

Полный regression один раз вне sandbox: require_escalated разрешён автоматически,
т.к. известный snapshots fs.watch EMFILE ограничен sandbox. Не тратили повторные
запуски на воспроизведение известной среды, тест не меняли.

```text
npm test
> pretest: npm run build
Test Files  18 passed (18)
Tests       322 passed (322)
Duration    8.81s
exit 0
```

Fresh pretest build проверял dist/server.js --client claude/codex. Smoke использует
приватные временные HOME/CODEX_HOME/CLAUDE_CONFIG_DIR и пустую/повреждённую настройку;
реальные Notes не вызываются. Все write tests используют fake Notes и temp HTML.
Нет обращения к реальному пользовательскому профилю, секретам, .env или .git/config.

## Покрытие интеграции

Оба host: реальный ticket store + runHook + write handler, однократность, файловый
произвол без билета, целые args/title/id/дополнительное поле, expiry, TIMEOUT_WRITE
и необходимость нового билета, снятие active. Все три write проверяют несколько
картинок полностью до Notes; подмена одной snapshot даёт 0 записей. Проверены
reference PNG, code fence, raw HTML img escaping, текст без transcript,
no-fallback resolver и no-consume текстового ticket. Ошибка построения resolver
снимает lease, сохраняя ошибку. Ошибки release после успеха/TIMEOUT_WRITE/OUTSIDE
не меняют результат и не разрешают повтор. Прежние locked/outside/attachments/
lists/truncated и неоднозначная папка остаются покрыты existing + extended tests.

## Изменённые файлы

- src/{server,tools,images,errors,runner}.ts
- src/attachments/tickets.ts
- test/{tools,server.smoke,images,runner}.test.ts
- test/attachment-integration.test.ts (новый)
- этот отчёт

scope.ts и его тесты не требовали изменения: существующие параметры hint и retry
совместимы, соответствующие тесты прогнаны. errors.test.ts также прогнан без правки.

## Self-review и ограничения

Проверен свой diff: удалён весь production imageSrc/defaultImageRoot, отсутствует
fallback, все grants проверяются до NotesService, lease освобождается на всех
путях после получения, нет изменения политик hash/one-use/15m/24h.
Исправлены только пробелы/лишние пустые строки после последнего полного прогона;
поведения после проверок не меняли. git diff --check без замечаний.
Автосборку tracked dist/{hook,server}.js возвращаем к чистой базе 015ca42 согласно
ownership: актуализация distributable принадлежит Task 7, source/tests проверены
со свежей сборкой. Известных нерешённых дефектов реализации нет.

Ограничение приёмки: Claude model/tool/image live NOT RUN — нет аккаунта;
auth-free наблюдаемые bytes + synthetic/documented envelopes не выданы за live PASS.
Git-source/публикация/изменение действующей установки не выполнялись.
