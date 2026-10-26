# Figma Ops: проверяемый native PNG export

Дата: 26 октября 2026. Статус: предложение следующей итерации; продуктовый код не меняется до implementation plan.

## Намерение и основание

Пользователь влил PR #16 и поручил продолжать улучшение figma-ops. Локальные установки обновлены до canonical 1.3.0 / alias 1.4.0 из `origin/main` SHA `4623096`. Сохраняется прежнее предпочтение прорабатывать решение без уточнений.

Пользовательский запрос на сокращение дублирующего REST проверен в [audit по всем 11 operations](../research/2026-10-26-figma-ops-rest-parity.md). При сохранении headless CLI безопасных удалений transport сейчас не найдено. Поэтому исполнитель предлагает законченный небольшой следующий шаг: убрать необходимость разового host-кода для проверки native PNG export. Это выбор исполнителя, а не новое требование пользователя сократить строки любой ценой.

На прошлой итерации native `node.exportAsync` уже дал скачанный корректный прозрачный PNG 2×. Проверка использовала ручной импорт `inspect_image`; сначала было ошибочно названо несуществующее `inspect_png`. Есть конкретная причина предоставить поддерживаемую команду. Preview Southleft ограничен длинной стороной 1568 px и не заменяет asset 2×.

## Цели, границы и прежние решения

- Интерактивный PNG export точной ноды выполняется через Southleft Bridge без PAT, без изменения макета.
- Агент сохраняет полученные bytes средствами host и проверяет файл штатной offline командой, а не private imports.
- Проверка переиспользует существующий PNG decoder/validator; второй decoder, новый MCP client, HTTP слой и зависимости не добавляются.
- Сохраняются 11 прежних CLI operations, их schema/budgets/auth и самостоятельность обоих plugin roots. Новая команда оформляется отдельным entrypoint, чтобы не менять REST dispatcher.
- Native read не обещает document version, файл не объявляется принадлежащим Figma по одним локальным bytes. Geometry/source/target provenance подтверждается отдельно при capture.
- Поддерживается PNG. SVG/PDF/JPG/fills/QR, variable resolver, motion, запись в Figma, token migration, общий importer MCP JSON, удаление REST и optional companion package вне scope.

Исходное решение первой итерации — маршруты и проверка фактических assets, runtime не менялся. Сейчас добавляется публичный offline entrypoint вместо разового импорта helper; старый REST export остаётся для headless и неподходящего binary payload. Существующий read-only запрет сохраняется.

## Пользовательский сценарий

1. Агент получает точные file/branch key и node ID, проверяет active probe/connected files и актуальную схему targeted execute.
2. Выполняет PNG export recipe в точном файле, с in-code fileKey guard до node lookup. Сохраняет capture metadata отдельно от локальной проверки.
3. Host сохраняет bytes как новый локальный файл, без перезаписи по умолчанию; из plugin context писать путь на Mac нельзя. Preview не подменяет скачанный asset.
4. Запускает `python3 <installed-plugin>/scripts/figma_asset_verify.py <LOCAL_PNG>`; при известных требованиях задаёт ожидаемые **пиксели** и прозрачность.
5. Передаёт пользователю путь, фактические dimensions/alpha, результат сравнений, source identity и ограничения. Requested scale без проверки pixels не становится verified 2×.

Синтетический пример:

```sh
python3 /installed/plugin/scripts/figma_asset_verify.py /tmp/banner.png --expect-width 640 --expect-height 360 --require-transparency
```

## Native export recipe

Документируемый JS block в focused `references/native-assets.md` исполняется через текущий Southleft `figma_execute`, с тем же exact fileKey. Input: expectedFileKey, nodeId, scale (default 2, finite 0.01..4), maxBytes (default 1048576, integer 1..4194304). Node ID сохраняется полностью, включая composite IDs. Никаких children/page scans, selection changes, create/remove/import, временных заливок или smart resize.

Recipe проверяет fileKey до lookup; затем exact node existence и exportAsync capability. Формат всегда PNG. Передаёт SCALE constraint с запрошенным значением, не уменьшает scale ради payload cap. Возвращает JSON-safe capture receipt с fileKey/nodeId, version=null, source width/height и render bounds если реально доступны, scale_requested, format, byte_count, base64 и ограничениями.

Если PNG больше maxBytes, base64 **не возвращать**: явный partial с reason=export_size_limit, byte_count и requested scale; не считать экспорт завершённым и не апскейлить preview. Доступный существующий REST export допустим как другой разрешённый способ, без автоматической настройки auth. Policy denial/429 не являются основанием для обхода другим транспортом.

maxBytes — предел raw binary payload до base64; encoded строка примерно на треть больше. Это ограничение выдачи, а не обещание ограничить buffer, уже выделенный Figma при exportAsync. Ошибки/unsupported отражаются явно. Если tool потерял transport до ответа, исход неизвестен; не заявлять сохранённый файл по одному началу export.

Native receipt не обещает PNG dimensions/alpha: их проверяет decoder на реально сохранённом файле. Source width/height и render bounds — наблюдения API; из них автоматически не выводятся ожидаемые pixels для повернутых/эффектных объектов.

## Offline entrypoint и контракт

Добавить `scripts/figma_asset_verify.py`, Python 3.10+ stdlib, runnable из любого cwd. Он не создаёт Client, не разрешает credentials, не вызывает curl/security/MCP, не читает cache/.env/конфиги и не пишет файлы. Импорты существующих pure image/error helpers допустимы; их side effects проверяются тестом.

Аргументы: positional FILE; `--expect-width` и `--expect-height` положительные integers, задаются вместе либо оба отсутствуют; `--require-transparency` — boolean; `--help`. Формат PNG фиксирован, расширению файла не доверять. `--output`, TARGET URL/fileKey, network flags и token параметры не добавляются: stdout JSON сохраняет host.

Принимать только читаемый обычный файл; ограничить чтение 64 MiB + один sentinel byte, не загружать произвольный большой файл целиком. Некорректный path/type, отсутствие/read error, превышение input cap и повреждённый PNG — понятная ошибка без вывода содержимого. При валидном PNG вызвать существующий `inspect_image(content, 'png')`; алгоритм, пределы decoder и existing warnings не переписывать.

Один JSON receipt в stdout: schema_version=1, operation=verify-asset, source=local-file, status=ok|error, checked_at UTC, data, warnings и error nullable. Это новый локальный receipt, не REST dossier: не использовать helper, который фиксирует source=figma-rest, не подставлять фиктивные fileKey/version.

data содержит path, bytes, format, width, height, alpha, expected requirements и `checks`. Для valid_png и каждой заказанной проверки состояние passed|failed|unavailable; незаказанная проверка — not_requested. `provenance_verified=false` всегда: успешная проверка pixels не доказывает происхождение/ноду/полноту capture. Не выводить общий verified=true, скрывающий эту границу.

- Без заказанных expectations status=ok означает только валидный PNG и фактически доступные metadata.
- Width/height совпали — passed; не совпали — status=error, code=asset_mismatch, полезные metadata сохраняются.
- С require-transparency alpha=transparent — passed, opaque — failed/asset_mismatch, unknown — unavailable/verification_unavailable. Нельзя принять alpha channel за реально прозрачные pixels.
- Unknown alpha без требования допустим с сохранением decoder warnings. Валидационные ошибки сохраняют safe code/message, а не traceback/bytes.
- Exit0 — успешная проверка заказанных требований; exit1 — input/validation/verification error; exit2 — invalid arguments; help exit0. В stdout error сохраняется JSON, input файл остаётся неизменным.

Проверка масштаба делается сравнением с отдельно подтверждёнными ожидаемыми pixels, а не арифметикой helper по непроверенной source geometry. Не принимать MCP receipt/base64 или URL вместо файла; универсальный importer остаётся вне scope.

## Файлы, packaging и workflow

Новый focused reference `native-assets.md` содержит recipe, host handoff и offline проверку; `assets.md` и короткий main skill ссылаются на него. Не размещать все platform-specific host инструкции в основном skill. В отсутствие безопасного доступного file writer агент называет конкретный пробел, а не выдаёт base64/preview за готовый asset.

Переиспользовать существующий sync-compat.py: он копирует runtime .py и references. Теперь canonical и alias содержат 16 одинаковых runtime modules и восемь references; каждый root автономен. Предлагаемые версии: figma-ops 1.4.0, figma-lookup 1.5.0. Обновить manifests/catalogs/README, сохранив остальные plugins. Поддержка нового standalone helper проверяется отдельно от прежних 11 operations/12 help calls: эти счётчики не переименовываются в число разных новых команд.

CLI dispatcher/auth/HTTP client и decoder не меняют поведение; decoder улучшения, если обнаружатся, требуют отдельного обоснования. Новый helper может использовать существующие OpsError/strict JSON utilities, но не фиктивный REST envelope.

## Приёмка и проверки

- Recipe TDD исполняет actual fenced JS, а не его копию: wrong file до lookup, composite ID, scale defaults/limits, unsupported export, exact SCALE options, binary cap без base64/downscale, сохранение исходного receipt.
- Offline helper: валидный PNG с opaque/transparent pixels, wrong dimensions, unknown alpha при большом поддержанном decode пути, corrupted/truncated input, missing/non-regular file, cap и positive-integer pair arguments. Использовать existing meaningful fixtures/decoder; не дублировать decoder tests.
- Offline доказательство: нет token/env/cache/network/subprocess access и записи input, в том числе при ошибке; путь с пробелами, чужой cwd, оба изолированных plugin root. Новую runtime dependency не добавлять.
- Перед изменением skill сохранить baseline application scenarios, после проверить другую редакцию на тех же held-out задачах. Не выдавать explicit-file simulation за host activation и не повторять ранее запрещённую external child inference.
- Сохранить прежние 296 tests, добавить focused regressions для нового workflow. M1 из финального ревью PR #16 — необязательное ранее coverage для **существующего bounded-subtree recipe** в mcp-routing.md: getter обычного поля `annotations` бросает исключение. Теперь добавить regression assertion: поле получает state=unavailable, receipt partial=true и frontier reason field_unavailable; соседние false/zero values и доступный child сохраняются в пределах прежних bounds. Точечный эксперимент ревьюера уже подтвердил корректное поведение, product fix не требуется. После meaningful изменений запускать подходящие checks, без повторения suites без причины.
- Live read-only export выполнить только при доступном exact connected file и подходящем target. Если Bridge остаётся offline, проверить offline helper на ранее сохранённом разрешённом PNG как **историческом artifact**, отдельно отметить отсутствие нового live capture. Не перезапускать/переключать Figma ради зелёного отчёта и не создавать дизайн.
- Tracked отчёт sanitized: без корпоративных IDs/texts/values/images; раскрыть границы pixels/provenance, input/output caps, unsupported motion и отсутствие новой live проверки, если применимо.

## Решения исполнителя и builder check

Исполнитель выбрал отдельный offline entrypoint и PNG-only scope вместо изменения REST dispatcher, общего MCP importer или удаления функциональных CLI contracts. Это добавляет небольшой helper, а не сокращает общий runtime; польза — штатная проверка native export без разовых imports/REST в интерактивном пути. Builder определяет внутренние функции и структуру tests, точные safe error messages и форму receipt внутри перечисленных обязательных полей.

После fresh builder check документ передаётся на согласование; следующий артефакт — отдельный implementation plan. Создание нового кода, bump manifests, push/PR и обновление установок следующей версии до плана не выполняются.

## Результат builder check

Свежий reviewer запросил только расшифровку исторического M1, без которой нельзя было выбрать обязательный regression case. Ответ уже был в финальном ревью PR #16; конкретные recipe, getter и assertions добавлены в приёмку. Остальные существенные границы reviewer счёл определёнными. Новых вопросов пользователю это уточнение не требует.

После уточнения reviewer подтвердил: «nothing important left». Документ готов для составления отдельного implementation plan; продуктовый код этой итерации ещё не написан.
