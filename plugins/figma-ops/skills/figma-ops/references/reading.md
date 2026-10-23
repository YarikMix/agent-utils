# Структура, поиск, прототип и motion

## Inspect и поиск

```sh
python3 "$FIGMA_OPS_CLI" inspect SyntheticKey
python3 "$FIGMA_OPS_CLI" inspect 'https://www.figma.com/design/SyntheticKey/Example?node-id=1-2' --depth 2
python3 "$FIGMA_OPS_CLI" search SyntheticKey --query 'Нет соединения' --page '0:1' --output '/tmp/figma search.json'
python3 "$FIGMA_OPS_CLI" search SyntheticKey --query 'Повторить' --node '1:2' --type TEXT --limit 10
```

`inspect` без ноды — каталог страниц; с URL node-id либо `--node` — точная нода, ancestors, containing_frame, page, children. Узкое чтение `ids` может включать dependency-ноды, но target должен находиться по точному ID. `--depth` ограничивает отображённое source-поддерево **от выбранной ноды**, сохраняя ancestry; это не ограничение размера сетевого ответа. Сначала восстанови предков подложки/Fade/vector/icon instance из внешней ссылки: screenshot одного затемнения не показывает весь экран.

`search` ищет literal Unicode casefold подстроку в `name` и `characters`. Возвращает matched_fields, text/snippet, path, page, URL и coverage. `--page` и `--node` взаимоисключающие; оба ограничивают обход точным source-поддеревом, не соседями/dependencies. Без них поиск файловый, даже если TARGET URL содержит node-id. `--type` фильтрует точное имя типа, например TEXT/FRAME. `--limit` ограничивает inline выдачу, `--output` сохраняет все совпадения.

Начни с copy текста, затем смысловых имён фреймов: текст кнопки может называться `label` внутри instance. При нужде ищи `node-id=` и ID во всём релевантном репозитории задачи (`rg`), а не только src. После timeout широкого поиска начни с известного frame/section через `--node`; если кандидатов нет — получи каталог страниц и сузь `--page`. Не повторяй полный файл; непроверенную остальную область укажи явно. Пустая metadata/нет совпадений не доказывают отсутствие кейса. Coverage всегда loaded-document-only: неизвестные дети и внешние компоненты не исследованы. Укажи проверенные страницы и остаток.

Кандидата сверяй screenshot точного экрана. `get_design_context` нужен для реализации, а не разведки: выдача может обрезаться; сначала загрузи `figma-design-to-code`. Большие ответы сохраняй в файл и читай нужные поля. MCP text blocks в JSON извлекай через `json.load`, затем разбирай `text`; сырые файлы могут содержать `name=\"...\"`. Отступы дерева дают стек предков: при новом узле убери из стека элементы с отступом >= текущего. Не ограничивай длину имени regex и не теряй составные ID.

## Привязки дизайн-системы

Для used components/styles, полных instance property keys и variable aliases используй [bindings](bindings.md): `bindings` точного subtree или `context --with-bindings` переиспользуют существующий source/root. `componentId`, metadata `key` и TARGET file key — разные идентификаторы; remote key не разрешает читать другой файл. Полный response catalog не означает, что все его entries использованы в scope. Style metadata не даёт computed CSS, explicit mode map не даёт effective mode. Отдельное MCP `get_variable_defs` требует discovery текущей схемы; evidence сохраняется отдельно от REST IDs.

## Инстансы и геометрия

Пустой вложенный instance **внутри уже найденного объекта** раскрывай точным ID из родительской выдачи: `I101:200;301:400`, глубже `I101:200;301:400;501:600`. Сохрани `I` и все части после `;`. Это другой случай, чем пришедшая извне нода-подложка, где нужны предки.

Координаты могут быть относительно родителя. Сумма x/y без матриц трансформации неверна для поворота/масштаба; x/y повёрнутой ноды не равны верхнему левому углу видимой картинки. Если дерево расходится с рендером, проверь трансформации и измерь видимые края по проверенному экспорту. Размер `svgAssets` относится к экспортированному вектору: сравни его с viewBox/ассетом репозитория и CSS-размером, не выводи визуальный масштаб по одному положению. Подробности замеров — [assets](assets.md).

## Prototype: actions, BFS и raw timing

```sh
python3 "$FIGMA_OPS_CLI" prototype DemoFile --node '31:4' --follow 1 --max-frames 6 --output '/tmp/figma evidence/prototype.json'
```

`prototype` требует ноду из URL либо `--node`; по умолчанию follow=0, только точный subtree. Полные interactions сохраняют trigger и упорядоченный массив actions, включая вложенные CONDITIONAL branches, overlay/swap/change-to/scroll, BACK/CLOSE, URL/media/variable и неизвестные действия. Branches — возможные действия, не вычисленные ветки исполнения. Не исполняй expressions/actions/URL. Плоские edges — навигация только по NODE actions с ненулевым destinationId; null/BACK не дают выдуманной цели. Action JSON Pointer и condition path сохраняют место в исходном interaction; unknown payload сохраняется raw с warning/partial interpretation.

Modern `interactions`, даже `[]`, — основной источник. Legacy transitionNodeID/transitionDuration/transitionEasing остаются отдельно; при конфликте — warning без дубликата, при отсутствии modern — явно ограниченное legacy evidence без выдуманного trigger. Поле absent не равно пустому массиву: coverage считает ноды с/без поля, missing даёт fields_not_returned, malformed — partial.

`--follow` 0..3 — BFS по подтверждённым destinations; `--max-frames` 1..50, default 20, ограничивает общий budget roots, включая исходный и неуспешные попытки. Depth0 — source subtree, depth1 — первый destination. Уже загруженные ноды не запрашиваются снова; один дополнительный узкий GET на новый root, без скрытого page scan. Дедупликация защищает от циклов. На последнем depth actions читаются, следующие destinations остаются frontier. CHANGE_TO может вести в component variant: не заменяй его произвольным экраном.

Frontier сохраняет `depth_limit`, `frame_limit`, `forbidden`, `not_found_or_inaccessible`, `rate_limited` или `network_error`. При ошибке одного destination остальные результаты сохраняются; при 429 дальнейшие дополнительные GET прекращаются без sleep. Frontier/degraded interpretation дают partial и exit0. Пустой frontier не означает проверку входящего графа или всего файла; coverage остаётся scoped. Разные document versions сохраняются как наблюдения с warning.

Каждое численное поле времени сохраняется без округления с raw JSON Pointer: `raw_value`, `raw_field`, `documented_unit`, `verified_unit`, `normalized_ms`, `unit_basis`. Для REST transition/legacy duration и trigger timeout/delay documented_unit=ms по проверенной документации, mediaHitTime=s. До отдельной подтверждённой калибровки `verified_unit=null`, `normalized_ms=null`, `unit_basis=unverified`, warning `timing_units_unverified`. Документированная единица не становится проверенной автоматически. Не выводи секунды из малого числа и не переводь его в ms по догадке; одинаковое число REST/Plugin API не доказывает единицу UI. Этот warning сам по себе не делает сбор partial. Easing сохраняется raw со всеми cubic-bezier/spring параметрами, без подстановки CSS-кривой/придуманной spring duration.

## MCP и animation timelines

Metadata может не содержать interactions. Доступный официальный `use_figma` позволяет read-only чтение Plugin API `node.reactions`; перед КАЖДЫМ вызовом загрузи актуальный `figma-use` и сверь текущую схему. Не записывай reactions и не переключай прототип ради чтения. Сохраняй точные source/destination IDs и неизвестные поля без домыслов.

Keyframes — отдельный источник: доступный официальный `get_motion_context` запрашивается для выбранного frame/subtree, при необходимости отдельно для destination. Фактически возвращённый animated-node inventory, snippets, tracks и coordination hints сохраняй отдельным evidence artifact: наличие tracks не обещается любой схемой/ответом. REST transitions/Smart Animate не являются keyframe tracks. Для реализации motion — `figma-implement-motion`; перед `get_design_context` — `figma-design-to-code`, он нужен для реализации, не разведки. Через `use_figma` чтение motion требует также `figma-use-motion`. При unsupported API зафиксируй предел и продолжи остальное, без повторов. Полный workflow — [context](context.md).

Нарисованная линия между фреймами не доказывает prototype reaction. Если нужны именно линии канваса, выбери читаемый MCP screenshot или UI fallback по `peekaboo-control`: точные страница/оба фрейма, наконечник, перекрывающиеся участки длинной линии. Соседство экранов не доказывает связь, resting screenshot не показывает motion и не даёт duration/easing. Для motion нужна фактическая выдача или настройки, а не оценка по картинке.
