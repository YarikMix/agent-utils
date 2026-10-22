# Figma Ops: третья итерация — привязки дизайн-системы

## Задача и основание

После merge [PR #10](https://github.com/YarikMix/agent-utils/pull/10) локальный `main` обновлён до `df47c899e2f62ac0d1b79fc710e6b76a04bafe1b`. Установленные через symlinks skills используют merged `figma-ops 1.1.0` и `figma-lookup 1.2.0`; help трёх новых команд проверен для обоих имён. Дерево merge совпадает с проверенным итогом второй итерации: 196 tests OK. Незавершённая следующая итерация не должна подменять эту установку.

Пользователь попросил продолжить работу и ранее поручил работать без уточнений. Следующий объём выбран исполнителем: связать точный участок макета с используемыми компонентами, styles и variables. Это продолжает цель повысить самостоятельность агента при реализации интерфейса; пользователь не утверждал отдельно перечисленные ниже команды и поля.

Сейчас `context` сохраняет структуру, annotations, прототип и полные обсуждения. Для дальнейшей вёрстки агенту всё ещё приходится самостоятельно разбирать `componentId`, свойства instance, styles и variable aliases в полном `inspect` JSON. При этом одинаковый цвет не доказывает одинаковый token, имя component не доказывает Code Connect mapping, а недоступность Variables REST не доказывает недоступность definitions через MCP.

Результат третьей итерации: компактная машинная инвентаризация **реальных ссылок** в выбранном subtree, с metadata и явными неразрешёнными ссылками. Агент видит, какой instance использован, какие properties и прямые overrides наблюдались, какие style/variable IDs привязаны к конкретным полям и где искать следующий источник. Численные значения, имена токенов и соответствие компонентам кода не выдумываются.

## Проверка доступности 23.10.2026

На уже разрешённом файле выполнены только read-only исследования, через существующий REST client и официальный MCP:

- Узкий исходный subtree: 94 nodes, 34 INSTANCE, `componentId` и `overrides` на 34 nodes, `componentProperties` на 26, node-level `boundVariables` на 31, `explicitVariableModes` на одной, `styles` на восьми. В ответе также присутствовали metadata tables: 23 components, 14 componentSets, пять styles. Последние counts относятся к ответу API, а не доказывают принадлежность всех записей выбранному subtree.
- `GET files/:key/variables/local`: HTTP 403 / безопасная ошибка `forbidden`. Причина не установлена: plan, account type и scope остаются различными возможностями, токен не менялся.
- Официальный `get_variable_defs` для той же точной ноды: успешный JSON object с 11 определениями, строковые значения. Ответ не подтверждает наличие ID-to-name mapping, всех modes или alias graph. Приватные имена/значения в git не сохраняются.
- Документация Variables REST требует full membership в Enterprise и `file_variables:read`. `/local` возвращает local variables и используемые remote variables; `/published` не возвращает modes и не заменяет `/local` для их значений.
- Node/property documentation описывает component properties, definitions, overrides, metadata styles/components и nested `boundVariables` в paints/effects/component properties. Новые типы включают SLOT; их нельзя молча приводить к строке.

Источники: [Variables endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/), [Variables types](https://developers.figma.com/docs/rest-api/variables-types/), [File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/), [Node types](https://developers.figma.com/docs/rest-api/file-node-types/), [Property types](https://developers.figma.com/docs/rest-api/file-property-types/), [официальная OpenAPI](https://github.com/figma/rest-api-spec/blob/main/openapi/openapi.yaml), фактическая схема `get_variable_defs` текущего хоста.

Первое скачивание публичной OpenAPI остановило локальное execpolicy-правило `curl: forbidden`. Пользователь явно поручил заменить его на `allow` и перезапустил Codex; после этого тот же transport успешно скачал схему. Блокер закрыт, продуктовый transport не менялся. Проверенный файл: OpenAPI3.1.0, Figma API0.46.0, 424152bytes, SHA256 `4bee5505e5d469cb46531863cb827f3a04c3b52791d4d6583d49aafa4bf54a24`. Это публичная схема, без токена и данных пользовательского макета.

Схема подтвердила важные формы: `boundVariables` бывает одиночным alias, массивом aliases и вложенной картой (`size.x/y`, `individualStrokeWeights`, `componentProperties`); `explicitVariableModes` — map collectionID→modeID; `LocalVariableCollection.modes` — **массив** записей modeId/name, в том числе parentModeId, а не map, как можно прочитать в одном из текстовых описаний. SLOT value/defaultValue — объект SlotContentId с guid.sessionID/localID. Эти формы должны попасть в synthetic fixtures; неизвестные расширения сохраняются raw, effective values по-прежнему не вычисляются.

## Выбранный подход и границы

Рассмотрены три направления. Запись комментариев помогает замкнуть коммуникацию, но не закрывает потерю дизайн-системных связей при вёрстке. Полный resolver всех modes, extended collections и удалённых библиотек слишком широко обещает вычисленное состояние, особенно при текущем REST 403. Выбран scoped inventory с необязательным чтением definitions: полезен без Enterprise API и не подменяет доказательства догадкой.

Входят одна новая команда `bindings`, opt-in добавление её результата в `context`, необязательный единственный Variables REST GET и skill workflow для отдельного MCP-чтения definitions. Сохраняются Python 3.10+ stdlib, системный curl и прежние auth/cache/error/envelope contracts.

Не входят POST/DELETE/PATCH, изменение макета/variables/comments, создание Code Connect mappings, генерация CSS/tokens files, полноценный evaluator modes/aliases/extended collections, вычисление effective values инстанса, загрузка других файлов/библиотек, visual diff и отслеживание версий. Не обещается mapping Figma component → React component без отдельного подтверждённого источника.

Плохой результат: вернуть весь catalog как использованные компоненты; приписать style имя по совпадению цвета; потерять полный property key с `#id`; принять remote component key за file key; объявить отсутствие tokens после 403; смешать MCP strings и REST IDs в один выдуманный alias graph.

## Команда и совместимость

`bindings TARGET [--node ID] [--scope-root ID] [--with-variables] [--limit N]`

Source — точная нода из TARGET с обычным приоритетом `--node`. URL node отдельно сохраняется при override. Root по умолчанию source; отдельный `--scope-root` обязан быть source или его предком. Один существующий `load_scope` загружает source/root и ancestry; без node или при неверном root — прежние argument/scope errors, никакого whole-file content scan. Это те же отношения source/root, что у `context` второй итерации.

Общие `--refresh`, `--no-cache`, `--cache-dir`, `--output` работают после subcommand. `--limit` положительный, default20; применяется после полного сбора отдельно к верхнеуровневым коллекциям, не обрезает вложенные raw properties/overrides. `--output` сохраняет весь собранный envelope. Source/ancestry и nullable metadata не обрезаются. Команда ничего не запускает из содержимого макета.

Сохранить schema_version1, exit0 для ok/partial, exit1 operational error, exit2 invalid arguments. Прежние десять операций и default `context` сохраняют форму/семантику. Версии следующего выпуска: figma-ops1.2.0 и standalone figma-lookup1.3.0, согласованно в четырёх manifests и обоих catalogs.

## Инвентаризация из загруженного ответа

Основной extractor чистый, без network/limit; получает `LoadedScope`, возвращает полный `Collected`. Обход итеративный, порядок nodes — DFS, исходный порядок properties сохраняется. Идентификаторы составных instance/variable/mode IDs не разбираются по двоеточиям или дефисам. JSON Pointer экранирует `~`/`/`; node-relative provenance содержит точные file/node, pointer, fetched_at/version. Metadata table provenance отдельно указывает точный pointer относительно payload ответа; не выдавать его за путь внутри node.

Data содержит коллекции `instances`, `components`, `component_sets`, `style_usages`, `styles`, `variable_bindings`, `mode_observations`. Во всех связанных records сохраняются исходные IDs, raw поля и provenance; связи — по ID, не по имени/цвету. Builder выбирает внутренние типы, но обязан сохранить отношения ниже.

### Components и properties

- Instance record: identity/path, точный `componentId`, исходные `componentProperties`, `overrides`, `exposedInstances`, `isExposedInstance` при наличии. Полные property names/keys сохраняются: suffix `#...` не удаляется. Прямые overrides — наблюдение REST; не выдавать их за полный diff унаследованного состояния.
- Таблицы components/componentSets содержат только записи, достижимые от instance references scope; затем componentSetId из фактического metadata. Все остальные response entries — непроверенные посторонние metadata, не used inventory. Компонент/компонент-set, находящийся непосредственно в scope, тоже получает record даже без instance usage.
- Metadata сохраняет key/name/description/remote/documentationLinks и дополнительные raw fields. Отсутствующий metadata record — unresolved reference с missing coverage, не выдуманный component name и не подмена key/id. Malformed metadata — partial, доступные instances остаются.
- Если component definition уже загружен в response, допускается **точечный lookup по componentId** и извлечение componentPropertyDefinitions без дополнительного GET. Обозначить location `scope|loaded_dependency|not_loaded`. Dependency definition не становится частью scanned subtree; её children/prototype/комментарии не считаются исследованными. Весь dependency subtree не включать в record.
- BOOLEAN/TEXT/VARIANT/INSTANCE_SWAP/SLOT properties сохраняют тип и raw value/defaultValue/preferredValues/variantOptions/slotSettings. SLOT сохраняется структурированным raw object, а не строкой. Unknown types и повреждённые значения дают warning/partial interpretation, сохраняют raw и не скрывают соседние корректные properties. Не разбирать variant options из имени component.

### Styles

`style_usages` связывает точную ноду, исходный ключ node.styles и style ID с metadata record. `styles` содержит только реально сосланные IDs; key/name/type/remote/description и raw сохраняются. Metadata styles — описание, не полное определение визуальных свойств. Не генерировать из него CSS и не утверждать, что одинаковые resolved colors означают одну style.

Наблюдаемые fills/text style/effects доступны отдельным `inspect` по нужной ноде. Эта итерация не добавляет механизм вычисления их соответствия выбранному mode или исходному library style. Если metadata отсутствует, usage не пропадает и остаётся unresolved.

### Variable bindings и mode observations

Собрать node-level `boundVariables`, а также вложенные привязки в fills/strokes/background paints, gradient stops, effects, layoutGrids, text `style`/`styleOverrideTable` и componentProperties. Итерировать эти заранее названные property containers без рекурсии; не искать произвольные ключи `boundVariables` внутри pluginData, interactions/actions, annotations или иных unknown payloads. Путь каждой привязки должен вести к реальному месту в raw node. Внутри названных containers разрешён JSON-обход вложенных dict/list с сохранением pointer и указанием container role; unknown role остаётся raw evidence с warning, без обещания семантики поля.

Сохранить весь raw binding container, включая новые неизвестные поля. Для корректного `VARIABLE_ALIAS` записать точный variable reference ID и путь. Node-level карты могут содержать alias arrays и вложенные alias records: не терять исходный порядок, нули, false или пустые строки в соседних значениях. Unknown alias form и malformed known alias дают raw/warning/partial, а не ложную ссылку. Для каждого binding отделить `reference_id` от любого human name и `definition_state=not_requested|available|unresolved`.

`mode_observations` содержит **только реально возвращённые** `explicitVariableModes` у ancestors выбранного scope root и у самого root/descendants, с identity/pointer и location `ancestor|scope`. Каждая нода учитывается один раз: предки source внутри расширенного root относятся к scope. Ancestor observations — evidence для выбора дальнейшего чтения, не дополнительные scanned nodes. Отсутствие explicit map не доказывает default mode; inherited mode, effective mode, computed value и resolved alias value здесь не вычисляются.

## Необязательные variable definitions

`--with-variables` разрешает один дополнительный GET `/files/:key/variables/local` после успешного source/root. Это file-wide metadata endpoint, что явно отражается как `request_scope=file-variable-metadata`; он не поддерживает subtree-фильтр. Автоматического запроса без флага, `/published` fallback, `/me`, повторов после 403/429, обхода в другие files и поиска дополнительных credentials нет. Основная команда имеет максимум два GET: один nodes/source и один variables. Cache hits не превращают их в общую версию.

Ответ Variables API валидируется отдельно: meta.variables/meta.variableCollections должны быть objects; корректные соседние entries сохраняются при повреждённой записи. Отдельная section `variables` имеет собственные fetched_at/cache, `version=null`, state/coverage/warnings/error. Основной GET неуспешен — error всей команды. Variables GET запрещён, повреждён или failed — partial с полезным bindings section; не blanket Exception. При отсутствии флага section `not_requested` с null data/error/timestamp, и это само по себе не partial.

Возвращать definitions, реально требуемые найденными variable references, и их локально доступное alias closure, а не весь catalog. Сохранять исходные mapping key, id/key/subscribed_id, name/type/codeSyntax, valuesByMode, remote/deleted flags, raw collection/modes/extension data. Отдельные списки: `variables`, `variable_collections`, `alias_links`, `unresolved_references`. Дополнительные таблицы, использованные только для metadata lookup, не расширяют semantic node scope.

Индекс definitions принимает точные непустые mapping key/id/subscribed_id; если один reference указывает на разные records, результат ambiguous/unresolved. Не смешивать stable `key`, main-file id и subscribed_id по эвристике. Alias links извлекаются из реально возвращённых valuesByMode и extension overrides, включая composed color aliases. Обход closure итеративный с visited set; циклы перечисляются как links, не зацикливаются и не объявляются вычисленными значениями. Если нужной definition нет, она deleted-but-referenced, malformed или ambiguous — явный unresolved reason, полезный raw остаётся.

Значения всех modes, extended collections/parentModeId/overrides и composed color сохраняются raw. **Ни effective mode, ни разрешение alias в конечное значение не выполняются**. Даже полный локальный closure не означает применённого к ноде значения. Если definitions прочитаны, но binding не имеет однозначной корректной definition, section partial; missing properties учитываются отдельно. Отсутствие graph resolution как незаказанной функции partial не создаёт.

## Envelope, sections и coverage

`bindings` data сохраняет source_node, scope_root, url_node_id, ancestors/page и `sections={bindings,variables}`, плюс структурированные `next_actions`. Section wrappers повторяют state/source/fetched_at/version/coverage/data/warnings/error из `context`; endpoint cache отмечается внутри соответствующей section coverage. Для одного source response `snapshot_consistency=single-response`; при запрошенных variables — `independent-requests`, даже если они failed или timestamps совпали. Envelope version относится только к source response.

Coverage.complete=false; semantic scope — loaded-subtree. Счётчики node scope не включают response dependencies/ancestor observations/весь variables catalog. Для каждого optional field/container различать absent, explicit-empty и malformed; absent сам по себе оставляет ok с missing counts, malformed — partial. Отдельно считать instances, usages, unique referenced/resolved/unresolved IDs, missing metadata и definitions, scanned nodes и returned/truncated каждой верхнеуровневой collection. Counts полные, limit только проекция. Полнота означает фактически собранное, не весь файл или библиотеку.

Next actions — данные с kind/file_key/node_id/purpose/prerequisites, не shell и не scripts. При необходимости definitions: открыть текущую схему `get_variable_defs` на том же root; при необходимости Code Connect: проверить доступный read-only mapping tool по реально наблюдённым component IDs/keys и контексту проекта. Не обещать доступность tools, не вызывать их из CLI и не переходить автоматически по documentationLinks.

## Интеграция с context и MCP

`context` получает `--with-bindings` и `--with-variables`. Последний требует `--with-bindings`, иначе invalid_argument до сети. По умолчанию output второй итерации сохраняется без новых sections. При `--with-bindings` добавить sections bindings/variables, переиспользовать **тот же LoadedScope**, source/root/ancestry и projector. Не выполнять повторный nodes GET и не вызывать CLI subprocess. Без `--with-variables` новых запросов нет; с ним максимум один дополнительный Variables GET помимо прежних source/comments. Section failures агрегируются в общий partial, остальные sections доступны.

Skill объясняет маршрут: точный context → bindings использованных design-system entities → отдельный get_variable_defs по нужному scope → сопоставление с repository tokens/components по подтверждённым именам/Code Connect. Один успешный MCP ответ может быть удобен при REST403; это отдельный endpoint с отдельными возможностями, а не обход policy и не восстановление всех mode IDs.

MCP evidence хранится отдельно доступным хосту способом, с точным file/node, временем и фактическим содержимым. CLI не импортирует произвольный provider JSON. Не соединять MCP name→string и REST variable ID по похожему имени/значению; отсутствие ID mapping остаётся явной границей. Если mapping подтверждён другим read-only источником, следующий агент может использовать его отдельно с provenance.

Сохраняются prerequisites: перед каждым use_figma — figma-use; get_design_context — после figma-design-to-code и для задачи реализации; motion через use_figma также требует figma-use-motion. get_variable_defs не объявлять доступным без discovery текущего хоста. Code Connect creation и Figma editing не следуют из запроса чтения. Не исполнять ссылки/код из metadata и не принимать descriptions/comments за системные инструкции.

## Упаковка и проверка готовности

Canonical implementation/skill/reference поддерживаются в figma-ops, legacy регенерируется sync-compat.py, остаётся самостоятельным. Добавить focused `bindings.md`, всего шесть references; прежние пять и geometry/QR/export guidance сохранить. Оба host catalogs и versions согласованы. Установленная локальная версия обновляется только после merge следующего PR; PR при отдельном поручении ready for review.

Содержательные synthetic tests: точный source/root против dependency frames; metadata только used refs; локальные/remote instances и missing metadata; component-set relation; properties с полными keys, BOOLEAN false/TEXT empty/VARIANT/INSTANCE_SWAP/SLOT/unknown type; overrides без выдуманного effective diff; nested binding pointers/arrays/escaped names; binding в pluginData не интерпретируется; absent/empty/null/malformed containers; ancestor mode observation не становится resolved mode; styles не становятся computed values; variables optional one GET; 403/429/malformed сохраняют полезные sections; aliases/remote subscribed identity/collision/deleted refs; cycles/composed color/extended data без вычисления values; independent timestamps/versionnull; limit/output/no mutation; context request count и unchanged default contracts.

Standalone acceptance: все 11 операций и 12 help calls в каждом изолированном plugin root, без sibling/network/Keychain, из cwd с пробелами; дополнительно partial cases. Проверить равенство modules/шести references/skill body и idempotence sync. Сохранить существующие 196 tests, добавить необходимые regressions; Python3.10 syntax отдельно от runtime. Не повторять успешные suites без изменения кода/неразрешённых сомнений.

До правки skill — OLD на отложенных задачах, после — свежий NEW. Проверять различение componentId/key/fileKey; used metadata против whole catalog; style metadata против resolved values; mode observations против effective mode; REST403 при рабочем MCP; immutable source/root и budgets. Не копировать held-out задачи в продуктовые examples; не выдавать simulated routing за host activation или выдуманный количественный выигрыш. Исторически отклонённый child CLI не повторять.

Live read-only на разрешённом узком участке: bindings должен вернуть реальные instances/styles/variable refs с точными IDs и scope; opt-in Variables REST403 — полезный partial; get_variable_defs — независимое evidence, если tool ещё доступен. Положительный REST definitions/alias closure, component definitions/SLOT/extended data проверять live только при наличии уже доступного подходящего источника; иначе явно оставить непроверенными и покрыть synthetic fixtures. Не создавать/изменять дизайн ради проверки. Никакие приватные identifiers/texts/values не попадают в tracked fixtures/report.

Готовность: отдельный implementation plan по этой спецификации, TDD/task reviews/whole-branch review, зелёные checks и самостоятельные copies; live успех или точная описанная граница. Сейчас написан только дизайн: продуктовый код, manifests и установленная версия не меняются. Ветка/worktree сохраняются, push/PR/merge требуют отдельного поручения.

## Решения исполнителя и работа builder

Исполнитель выбрал scoped bindings inventory, opt-in REST definitions и отдельный MCP workflow вместо полного value resolver или операций записи. Цена — effective values и Code Connect mapping не будут вычисляться этой итерацией, а дополнительный API остаётся зависимым от доступа. Отдельный flag для context сохраняет default contract ценой явного выбора расширенного досье.

Builder определяет имена внутренних modules/helpers/types, формат конкретных warning codes, компактную форму rows/linked metadata и декомпозицию tasks. Эти решения не могут менять exact IDs/scope, raw preservation, partial semantics, число GET, отказ от вычисления effective values или границы авторизации. Перед передачей дизайна выполняется fresh builder check; его существенные вопросы закрываются в документе.

## Результат builder check

Свежий агент прочитал дизайн для подготовки будущего плана: «nothing important left». Существенных неразрешённых вопросов нет. Уточнена только дедупликация mode observations при расширенном root: ancestors root отдельно, nodes внутри scope один раз. Продуктовый код не изменялся; следующий артефакт — implementation plan.
