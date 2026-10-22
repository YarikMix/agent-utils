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

## Инстансы и геометрия

Пустой вложенный instance **внутри уже найденного объекта** раскрывай точным ID из родительской выдачи: `I101:200;301:400`, глубже `I101:200;301:400;501:600`. Сохрани `I` и все части после `;`. Это другой случай, чем пришедшая извне нода-подложка, где нужны предки.

Координаты могут быть относительно родителя. Сумма x/y без матриц трансформации неверна для поворота/масштаба; x/y повёрнутой ноды не равны верхнему левому углу видимой картинки. Если дерево расходится с рендером, проверь трансформации и измерь видимые края по проверенному экспорту. Размер `svgAssets` относится к экспортированному вектору: сравни его с viewBox/ассетом репозитория и CSS-размером, не выводи визуальный масштаб по одному положению. Подробности замеров — [assets](assets.md).

## Прототипные реакции и animation timelines

Metadata описывает структуру и может не содержать взаимодействия. Сегодня официальный `use_figma` позволяет read-only запрос свойств Plugin API, включая `node.reactions`: trigger, actions, destinationId и transition (с type/duration/easing, когда поля присутствуют). **Перед каждым вызовом загрузи figma-use**, проверь текущую схему и руководство. Получай точные source/destination ID, trigger, transition, единицы времени; отсутствующие поля оставляй неизвестными. Не записывай reactions и не переключай прототип ради чтения. Возможность чтения не требует изменений документа.

Animation keyframes — отдельный источник: официальный `get_motion_context(fileKey,nodeId,recursive)` отдаёт animated-node inventory, keyframe tracks, easing, code snippets и timeline coordination hints. Используй `figma-implement-motion`, если результат нужен как код; `get_design_context` отвечает за структуру и требует своего prerequisite. Для чтения motion через `use_figma` сначала загрузи `figma-use` и `figma-use-motion`; API motion может зависеть от feature flag — при unsupported API не повторяй и зафиксируй недоступность. Не подменяй timeline данными prototype transitions или наоборот.

Нарисованная линия между фреймами не доказывает prototype reaction. Если нужны именно линии канваса, выбери читаемый MCP screenshot или UI fallback по `peekaboo-control`: точные страница/оба фрейма, наконечник, перекрывающиеся участки длинной линии. Соседство экранов не доказывает связь, resting screenshot не показывает motion и не даёт duration/easing. Для motion нужна фактическая выдача или настройки, а не оценка по картинке.
