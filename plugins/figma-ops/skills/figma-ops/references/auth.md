# Доступ MCP, REST и диагностика

Обычное Bridge Plugin API чтение подключённого точного файла не требует PAT. Discovery, active probe и fileKey guard — [mcp-routing](mcp-routing.md). Southleft comments используют REST и отдельный `FIGMA_ACCESS_TOKEN`; CLI использует `FIGMA_TOKEN`/Keychain. Эти credentials не взаимозаменяются автоматически. Не переносить токены, не менять Codex config, не устанавливать MCP или wrapper ради чтения. При отсутствии Southleft PAT для comments используй существующий CLI auth. Официальный MCP имеет собственные текущие prerequisites/session lifecycle.

REST CLI использует только уже заданный `FIGMA_TOKEN` либо на macOS существующую запись Keychain: service `figma-rest`, account `figma`. Применяется первый доступный источник. Не читай `.env`, конфиги MCP/клиентов, другие хранилища и не ищи запасные токены. Не выводи секрет и не вставляй его в argv, shell-команду, историю, логи или отчёт. Если credential отсутствует, используй доступный MCP/UI; создание и настройка токена не нужны автоматически.

Для целевой REST-операции прочитай её reference. При необходимости отдельно проверить подключение:

```sh
python3 "$FIGMA_OPS_CLI" doctor --no-cache
```

`doctor` делает только GET `/me`, подтверждает identity и источник credential, **не** проверяет scopes других endpoint и MCP. Не включай персональные поля identity в публичные отчёты. Нужные права: `current_user:read` для doctor; `file_content:read` для inspect/search/export/fills/annotations/prototype/bindings и source/root context; `file_comments:read` для comments/thread. `comments --node` дополнительно читает структуру, поэтому требует также `file_content:read`. Успешный doctor не обещает доступ ко всем файлам.

`bindings` без дополнительных definitions требует `file_content:read`. Только явный `--with-variables` добавляет `/files/:key/variables/local`: нужны `file_variables:read` и соответствующие Enterprise/full-member account requirements ([официальные условия](https://developers.figma.com/docs/rest-api/variables-endpoints/)). Это file-wide metadata, даже когда inventory scoped. Один HTTP 403 не устанавливает точную причину: scope, account/plan и доступ к файлу различаются. Не меняй credentials и не пробуй `/published`, `/me`, повтор после 403/429 или другие files ради обхода. Полезные bindings остаются в partial; тарифный REST Variables 403 сам по себе не доказывает запрет независимого предусмотренного Plugin API. Для local definitions предпочти scoped Bridge read; официальный `get_variable_defs` — отдельное evidence без догадки об ID mapping. Подробнее — [bindings](bindings.md).

Policy/organization denial или явный forbidden на файле/операции останавливает соответствующее действие: не менять транспорт и credentials для обхода. При 429 сохрани `retry_after` и уже полученное, не переключай транспорт для обхода throttling. Unsupported/missing capability и Bridge offline допускают другой разрешённый read; Variables plan limitation не обобщается на любой 403.

CLI передаёт заголовок токена curl через stdin; запросы с токеном только на `https://api.figma.com/v1/`, TLS проверяется, API-redirect не следует. Asset downloads идут без токена. Timeout API 35 секунд. HTTP 401 — credential; 403 — доступ запрещён без установленной точной причины; 404 — отсутствует либо недоступно; 429 возвращает `retry_after` без автоматического sleep/retry. Не объявляй файл удалённым по одному 404.

JSON schema_version 1: `operation`, `source`, `file_key`, `version`, `fetched_at`, `cache`, `coverage`, `data`, `warnings`, `error`, `status=ok|partial|error`. Exit 0 — ok/partial, 1 — operational error, 2 — invalid arguments. При `--output PATH` полный envelope атомарно сохраняется в файл, stdout содержит краткий envelope с путём и размером. Output-файл заменяется; для каждого результата выбирай собственный путь.

Кэш 300 секунд, разделён по hash identity-token и endpoint/query; permissions каталога/файла 0700/0600. `--refresh` заменяет кэш свежим результатом; `--no-cache` выключает чтение и запись. Stale fallback нет. Для актуальной ветки обсуждения используй refresh. Кэш/артефакты содержат данные макета — храни в каталоге задачи, исключённом из публикации.

Проверку missing credential не проводи стиранием или изменением реальных настроек. Операции чтения CLI используют только GET. Наличие credential не разрешает изменения без поручения пользователя.

## Веб-сессия для изменения комментариев

`comment-resolve`, `comment-unresolve`, `comment-edit` используют cookie только
на `https://www.figma.com/api/file/{key}/comments/{id}`. PAT туда не передаётся,
cookie не передаётся на публичный REST. Обычные чтения не требуют веб-сессии.
Нужны оба вида доступа: PAT с `file_comments:read` для проверки и веб-сессия
аккаунта, которому Figma разрешает запрошенное изменение.

Когда изменение поручено, а сессии нет, предложи пользователю локальную настройку:

1. Войти на `https://www.figma.com` в своём браузере.
2. DevTools → Application (Storage) → Cookies → `https://www.figma.com`:
   скопировать **значение** `__Host-figma.authn`, не весь заголовок Cookie.
3. Во вкладке Network выбрать запрос самого Figma: взять `X-Figma-User-Id`
   из Request Headers для того же аккаунта. Если такого заголовка нет, не
   подставлять ID другого аккаунта; сообщить, какое поле недоступно.
4. В интерактивном терминале на машине, где запускается CLI:

   ```sh
   python3 "$FIGMA_OPS_CLI" session-login
   ```

   Вставить cookie в скрытый ввод, затем числовой user ID. В WSL запускать
   команду в WSL: браузер Windows может быть источником вручную введённой сессии.
   Не вставлять секрет в чат, аргументы, shell-команду, `.env` или PR.

Команда сохраняет `~/.config/figma-ops/session.json`, каталог 0700 и файл 0600
на POSIX; symlink и небезопасное существующее хранилище отклоняются.
На Windows chmod не гарантирует POSIX-изоляцию: профиль и файл должны быть
доступны только вашему пользователю через ACL. Автоматического извлечения
данных браузера нет. Секрет не выводится; `stored=true, authenticated=false`
означает только локальное сохранение, не успешный вход в Figma.

При истечении сессии повторить `session-login` с актуальными значениями.
Чтобы удалить только сохранённую сессию CLI:

```sh
python3 "$FIGMA_OPS_CLI" session-logout
```

Это не logout в браузере. PUT не следует редиректам, проверяет TLS и не
повторяется автоматически. Cookie отправляется curl через stdin; ответы ошибок
не содержат сырое тело сервера. Подтверждение результата и неопределённый исход —
[comments](comments.md). Внутренний API не имеет гарантии стабильности.
