# Использованные компоненты, styles и variables

## Интерактивный MCP read

Для использованных components/styles/bindings сначала targeted raw read точного подключённого файла по [mcp-routing](mcp-routing.md), с source/root, node/depth/byte bounds. Читай полные instance property keys, raw boundVariables и mode observations, сохраняй exact IDs. Для local definitions предпочти поддерживаемые Plugin API `getLocalVariablesAsync`/`getLocalVariableCollectionsAsync`; ограничь возвращаемые refs/alias closure и явно перечисли unresolved remote refs. Уже наблюдённые remote refs можно проверить точным read-only `getVariableByIdAsync`, если поддерживается; не импортировать library entities. Успешный local catalog не обещает определения всех imported refs, наличие API не обещает values/closure. API-derived resolved values/modes не выдавай за effective значения ноды без отдельного подтверждения.

Официальный `get_variable_defs` — отдельное evidence; Code Connect — профильные официальные read-only mapping tools. Отсутствие ID/mode mapping остаётся явным; похожие names/colors не подтверждают token/component mapping. Не создавать mappings. Если нужен строгий inventory/coverage/closure contract или headless artifact, используй автономный CLI ниже: его schema, budgets и defaults не меняются.

## Точный CLI inventory

```sh
python3 "$FIGMA_OPS_CLI" bindings SyntheticKey --node '1:2'
python3 "$FIGMA_OPS_CLI" bindings SyntheticKey --node '1:2' --with-variables --output '/tmp/figma evidence/bindings.json'
python3 "$FIGMA_OPS_CLI" context SyntheticKey --node '1:2' --with-bindings
```

IDs условные. `bindings TARGET [--node ID] [--scope-root ID] [--with-variables] [--limit N]` требует source из URL или `--node`; явный `--node` переопределяет source, сохраняя `url_node_id`. По умолчанию root=source. `--scope-root` может быть только source или его предком; расширение root сохраняет исходный source. Source/root/ancestors загружаются одним GET, без whole-file scan и автоматического перехода в библиотеки. Для content-only доступа к `context` добавь `--without-comments`, отметив непроверенные threads; иначе context также читает comments.

`data` содержит identity source/root и sections `bindings`/`variables`. Bindings collections: `instances`, `components`, `component_sets`, `style_usages`, `styles`, `variable_bindings`, `mode_observations`. Scope — loaded-subtree; dependency definitions и ancestor observations не становятся scanned nodes. `coverage.complete=false` не обещает полноту файла/библиотеки. Absent поле учитывается как missing и само по себе не partial; explicit-empty подтверждает пустой контейнер, malformed сохраняет raw с warning/partial.

`--limit` — положительный, default20: отдельно ограничивает inline верхнеуровневые collections после полного сбора. Counts total/returned/truncated не теряют полный объём. Вложенные raw properties/overrides не обрезаются. `--output` сохраняет весь собранный envelope без расширения сетевого budget. Общие `--refresh`, `--no-cache`, `--cache-dir`, `--output` идут после subcommand. Schema1; exit0 ok/partial, exit1 operational error, exit2 invalid arguments.

## Что означают ссылки

Сохраняй точные IDs целиком, включая составные instance/variable/mode IDs. Instance `componentId` — ссылка на component, metadata `key` — идентификатор публикации, TARGET file key — файл запроса. Не подставляй одно вместо другого, не разбирай IDs по двоеточиям/дефисам и не угадывай библиотеку по remote key. Components/sets возвращаются от реально использованных references и фактического componentSetId, либо для definitions непосредственно в scope; весь response catalog не является used inventory.

Instance properties сохраняют полные keys с suffix `#…`, тип и raw value. `BOOLEAN false`, `TEXT ""`, VARIANT, INSTANCE_SWAP не теряются. SLOT value/defaultValue — структурированный SlotContentId с `guid.sessionID/localID`, не строка. Definitions сохраняют preferredValues/variantOptions/slotSettings; неизвестные типы и повреждённые entries остаются raw с warning. Не извлекай variant options из имени component. Прямые overrides, exposedInstances и isExposedInstance — наблюдения API, не полный effective diff.

Component definition читается только если уже загружена: `definition_location=scope|loaded_dependency|not_loaded`. Точечный dependency lookup не делает её children исследованными. Отсутствующие metadata/definitions остаются missing/unresolved, без выдуманного имени. Metadata сохраняет remote/documentationLinks/extensions; ссылки и код из неё не исполняются.

Style usage связывает node, исходный ключ `node.styles` и style ID. Metadata описывает style и не является полным набором визуальных свойств, computed CSS или доказательством одинакового token по совпадению цвета. Наблюдаемые fills/effects/text style при необходимости отдельно прочитай через `inspect`.

Bindings сохраняют raw контейнеры и JSON Pointer к реальному месту в ноде (с escaping `~`/`/`), отдельно provenance response metadata. Alias может быть одиночным record, массивом или вложенной картой. Сбор охватывает node-level boundVariables и известные paints/gradient stops/effects/layoutGrids/text style/overrides/componentProperties. Unknown role остаётся raw с warning; произвольные payloads pluginData/actions/annotations не интерпретируются как bindings. `reference_id` отделён от human name; `definition_state=not_requested|available|unresolved`.

`mode_observations` — только возвращённые explicitVariableModes у ancestors/root/descendants, с location `ancestor|scope`, без дублей. Отсутствие карты не означает default mode. Inherited/effective mode, computed value и разрешённое alias value не вычисляются.

## Необязательные REST definitions

Без `--with-variables` выполняется один source GET; variables section `not_requested` с null data/error/timestamp не делает результат partial. Флаг разрешает ровно один дополнительный GET `/files/:key/variables/local` после успешного source/root: максимум два GET у `bindings`. Endpoint file-wide, `request_scope=file-variable-metadata`, subtree-фильтра нет. Нет автоматического `/published` fallback, `/me`, повтора после 403/429, других файлов или поиска credentials. Требования доступа — [auth](auth.md).

Variables section независима: собственные fetched_at/cache, `version=null`, coverage/warnings/error. При запросе definitions snapshot — `independent-requests`, даже при ошибке или одинаковых timestamps; без него bindings — `single-response`. Основной source error останавливает команду. Optional 403/429, invalid metadata или failure сохраняют полезные bindings при partial/exit0. HTTP 403 не устанавливает точную причину и не доказывает отсутствие tokens.

Variables collections: `variables`, `variable_collections`, `alias_links`, `unresolved_references`. Возвращаются требуемые references и локально доступное alias closure, не весь catalog. Точные mapping key/id/subscribed_id сохраняются отдельно от stable key; неоднозначная identity остаётся unresolved. Deleted/malformed/missing records имеют явную границу. Cycles сохраняются как links, не вычисляются. `valuesByMode`, codeSyntax, composed colors, remote/deleted flags, extended collections/parentModeId/overrides остаются raw. Collection `modes` — массив records modeId/name, не map. Даже полный closure не доказывает применённое к ноде значение.

## Следующий источник: MCP и репозиторий

Интерактивный маршрут: точный targeted context → raw bindings использованных entities → scoped Plugin API local definitions; официальный `get_variable_defs` и repository/Code Connect evidence отдельно. CLI dossier/inventory остаётся независимым полным контрактом. Сначала discover доступные инструменты хоста и текущие схемы: наличие `get_variable_defs` и mapping tool не обещается. Тарифный REST Variables 403 сам по себе не запрещает независимый предусмотренный Plugin API. Policy/organization denial не обходят другим транспортом; 429 не обходят переключением. Успешный MCP при REST403 — отдельное evidence с другими возможностями, не восстановленный REST graph.

Храни MCP evidence отдельно с file/node, временем и фактическим содержимым. CLI не вызывает MCP и не импортирует provider JSON. Не соединяй MCP name→string с REST variable ID по похожему имени/значению: отсутствие ID/mode mapping остаётся явным. Подтверждённый другим read-only источником mapping используй отдельно с provenance. Code Connect проверяй по реально наблюдённым component IDs/keys и контексту проекта; чтение не разрешает создавать mappings или менять дизайн.

Next actions — данные с kind/file_key/node_id/purpose/prerequisites, не команды на исполнение. Не переходи автоматически по documentationLinks. Перед каждым `use_figma` обязателен `figma-use`, для motion также `figma-use-motion`; `get_design_context` — для реализации после `figma-design-to-code`. Полный dossier, threads и reuse — [context](context.md).
