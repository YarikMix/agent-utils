# REST-доступ и диагностика

Обычное MCP-чтение не требует REST-токена. REST CLI использует только уже заданный `FIGMA_TOKEN` либо на macOS существующую запись Keychain: service `figma-rest`, account `figma`. Применяется первый доступный источник. Не читай `.env`, конфиги MCP/клиентов, другие хранилища и не ищи запасные токены. Не выводи секрет и не вставляй его в argv, shell-команду, историю, логи или отчёт. Если credential отсутствует, используй доступный MCP/UI; создание и настройка токена не нужны автоматически.

Для целевой REST-операции прочитай её reference. При необходимости отдельно проверить подключение:

```sh
python3 "$FIGMA_OPS_CLI" doctor --no-cache
```

`doctor` делает только GET `/me`, подтверждает identity и источник credential, **не** проверяет scopes других endpoint и MCP. Не включай персональные поля identity в публичные отчёты. Нужные права: `current_user:read` для doctor; `file_content:read` для inspect/search/export/fills/annotations/prototype/bindings и source/root context; `file_comments:read` для comments/thread. `comments --node` дополнительно читает структуру, поэтому требует также `file_content:read`. Успешный doctor не обещает доступ ко всем файлам.

`bindings` без дополнительных definitions требует `file_content:read`. Только явный `--with-variables` добавляет `/files/:key/variables/local`: нужны `file_variables:read` и соответствующие Enterprise/full-member account requirements ([официальные условия](https://developers.figma.com/docs/rest-api/variables-endpoints/)). Это file-wide metadata, даже когда inventory scoped. Один HTTP 403 не устанавливает точную причину: scope, account/plan и доступ к файлу различаются. Не меняй credentials и не пробуй `/published`, `/me`, повтор после 403/429 или другие files ради обхода. Полезные bindings остаются в partial; при доступном MCP отдельно discover `get_variable_defs`, сохрани его evidence без догадки об ID mapping. Подробнее — [bindings](bindings.md).

CLI передаёт заголовок токена curl через stdin; запросы с токеном только на `https://api.figma.com/v1/`, TLS проверяется, API-redirect не следует. Asset downloads идут без токена. Timeout API 35 секунд. HTTP 401 — credential; 403 — доступ запрещён без установленной точной причины; 404 — отсутствует либо недоступно; 429 возвращает `retry_after` без автоматического sleep/retry. Не объявляй файл удалённым по одному 404.

JSON schema_version 1: `operation`, `source`, `file_key`, `version`, `fetched_at`, `cache`, `coverage`, `data`, `warnings`, `error`, `status=ok|partial|error`. Exit 0 — ok/partial, 1 — operational error, 2 — invalid arguments. При `--output PATH` полный envelope атомарно сохраняется в файл, stdout содержит краткий envelope с путём и размером. Output-файл заменяется; для каждого результата выбирай собственный путь.

Кэш 300 секунд, разделён по hash identity-token и endpoint/query; permissions каталога/файла 0700/0600. `--refresh` заменяет кэш свежим результатом; `--no-cache` выключает чтение и запись. Stale fallback нет. Для актуальной ветки обсуждения используй refresh. Кэш/артефакты содержат данные макета — храни в каталоге задачи, исключённом из публикации.

Проверку missing credential не проводи стиранием или изменением реальных настроек. Все операции CLI только GET; наличие write-scope не разрешает отправлять сообщения, делать Resolve или менять макет.
