# TypeScript native LSP для Codex

`typescript-native-lsp-codex@1.1.0` предоставляет готовый Node.js-бандл MCP и скилл `typescript-native-lsp`. Импорт: `@zachsents/ts-mcp@0.3.7`, SHA `039e5f38503eb5ace3a82a4a55fb6d5e7dce3ce1`; локальные изменения и лицензии — в [UPSTREAM.md](UPSTREAM.md) и [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Установка

Нужны Node.js 20+ и глобальный TypeScript 7+:

```sh
npm install -g typescript@7 --registry=https://registry.npmjs.org/
codex plugin marketplace add YarikMix/agent-plugins
codex plugin add typescript-native-lsp@yarikmix-plugins
```

Начните новую сессию Codex. Каталог `yarikmix-plugins` содержит для Codex только этот плагин. [Установка в Claude Code](../README.md#claude-code) использует тот же идентификатор, но отдельную LSP-конфигурацию.

MCP работает локально через stdio и не требует входа во внешний сервис. В Codex CLI 0.162.1 серверный парсер не принимает поле `extensions` в portable `mcp.json`; отсутствие поля означает штатный режим без аутентификации. При обновлении Codex эту совместимость нужно перепроверить.

Глобальный `tsc` должен находиться в PATH. Альтернатива — `TSC_PATH` с абсолютным путём к установленному нативному `tsc` (`tsc.exe` на Windows). JS-launcher и локальная версия из `node_modules` проекта не подходят для `TSC_PATH`. MCP не скачивает пакеты, не запускает `npm install`, не использует TS6 или fallback tsserver. Первый запрос к файлу запускает native LSP; discovery работает и без установленного компилятора.

## Инструменты

Все `file` — абсолютные пути. `line` и `character` начинаются с 0; `character` — смещение в UTF-16, поэтому символ вне BMP занимает две позиции.

| Инструмент | Результат |
|---|---|
| `hover` | Тип и документация символа |
| `diagnostics` | Диагностика одного файла, quick fixes как данные |
| `references` | Места использования, включая объявление |
| `outline` | Символы файла |
| `rename` | Переименование с записью изменений в файлы |
| `inlay_hints` | Подсказки типов/параметров |
| `definition` | Исходные определения |
| `workspace_symbols` | Поиск символов в проекте, выбранном через `file` |
| `implementations` | Реализации интерфейса/символа |
| `prepare_call_hierarchy` | Элементы и непрозрачные `item_id` |
| `incoming_calls` | Входящие вызовы подготовленного элемента |
| `outgoing_calls` | Исходящие вызовы подготовленного элемента |

`rename` разрешён только по явной просьбе пользователя переименовать символ; остальные инструменты read-only. Quick fixes автоматически не применяются. Для hierarchy сначала подготовьте элемент, затем передавайте его `item_id` с файлом того же проекта. Идентификаторы не переносятся между проектами/сессиями и могут истекать при изменении значимых файлов или перезапуске сервера — подготовьте элемент заново.

После редактирования запросите `diagnostics` нужного файла. Автоматических push diagnostics исходников нет. Это не проверка всего проекта: отдельно запускайте его штатные typecheck и tests. Глобальная и проектная версии TypeScript могут различаться и выдавать разные результаты.

Изменения неоткрытых зависимостей могут появляться в результатах асинхронно до 2 секунд. При очевидно устаревшем ответе повторите запрос после короткой задержки; постоянная пауза перед каждым запросом не нужна. Ошибки чтения, invalid/expired IDs и ошибки LSP возвращаются явно; не трактуйте их как пустой успешный результат. Полное отслеживание произвольного внешнего графа импортов не гарантируется.

Сервер ограничивает проверку версии 5 секундами, initialization/request — 30 секундами, shutdown — 2 секундами; неактивные клиенты закрываются через 5 минут. stdout занят MCP; диагностика процесса идёт в stderr.

## Проверка пакета

Все команды ниже выполняются из этого каталога с публичным registry:

```sh
npm ci --registry=https://registry.npmjs.org/
npm --registry=https://registry.npmjs.org/ run build
npm --registry=https://registry.npmjs.org/ run verify-build
npm --registry=https://registry.npmjs.org/ run typecheck
npm --registry=https://registry.npmjs.org/ test
npm --registry=https://registry.npmjs.org/ run test:live
npm --registry=https://registry.npmjs.org/ run test:codex -- --marketplace /absolute/path/to/clean-marketplace-root
```

Для `test:codex` нужен установленный Codex CLI и TS7 вне checkout. Используйте чистый экспорт репозитория без `node_modules`, либо подготовьте временный marketplace root только с `.agents/plugins/marketplace.json` и файлами runtime-пакета по его `source.path`: `plugin.json`, `mcp.json`, `package.json`, `dist/`, `skills/`, лицензии и документация. CLI копирует локальный source, поэтому development checkout с установленными зависимостями не подходит для этой проверки.

Harness создаёт отдельный временный `CODEX_HOME`, реально добавляет marketplace/plugin, проверяет copied cache без `node_modules`, plugin provenance, 12 tools, skill из cache и реальные hover/references/diagnostics/definition через собственный AppServer. `--ref <ref>` передаётся в marketplace add для Git-источника. Exit 0 означает прохождение всех assertions. Checkout PATH и NODE_PATH исключаются. Предупреждения CLI/AppServer остаются в stderr; JSON-отчёт не содержит credentials.

По умолчанию принадлежащий harness временный каталог удаляется после закрытия AppServer. `--keep-temp` сохраняет cache и `report.json` для последующей проверки, включая ожидаемую неуспешную пробу без skill; ненулевой exit при этом сохраняется. JSON содержит `tempRoot`/`cacheRoot`. После дополнительных проверок удалите именно указанный `tempRoot`; процессы harness уже закрыты.

Установочная проверка выполняется без model turn. Отдельная проверка поведения с обычным login и runtime skill root + временным прямым MCP из installed cache проверяет содержимое скилла и инструментов. Она не подтверждает совмещённый authenticated marketplace model-turn flow. Windows/Linux требуют реального CI; локальные проверки на macOS не подтверждают эти платформы.

## Обновление upstream

Обновление только вручную: выбрать конкретный upstream SHA, сверить лицензию и изменения API, перенести нужные изменения с тестами, обновить `UPSTREAM.md`, lock и notices, пересобрать `dist/server.js` и выполнить проверки. Автоматических загрузок или синхронизации нет. Пакет `private: true` и не предназначен для публикации в npm.
