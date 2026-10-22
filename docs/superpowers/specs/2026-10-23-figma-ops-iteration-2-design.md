# Figma Ops: вторая итерация — контекст, annotations и прототип

## Зачем и на какой основе

После merge [PR #9](https://github.com/YarikMix/agent-utils/pull/9) в `main` (`510fb171cbd4fce9618c949aa101222016d68abb`) первая итерация даёт семь отдельных операций чтения. Агент уже может найти исходную ноду, обсуждение и ассеты, но ещё самостоятельно соединяет результаты и отдельно выясняет поведение экрана. Это приводит к повторным запросам, потере replies/привязок и смешению прототипных переходов с keyframe animation.

Цель второй итерации: по точному subtree получить компактный проверяемый контекст — где находится нода, что написано в annotations, какие взаимодействия заданы и что осталось проверить через MCP. Основной потребитель — агент, который дальше реализует или проверяет интерфейс. Критерий полезности: следующий агент получает факты с точными ссылками и охватом, а не снова начинает разведку файла.

Пользователь поручил продолжить brainstorming и ранее попросил работать без уточнений. Объём ниже выбран исполнителем на основе первой спецификации, где прототип/motion и единый сборщик контекста оставлены второй итерации. Это не утверждение, что пользователь отдельно согласовал каждый новый флаг или формат.

## Что входит и что остаётся за границей

Входят три дополняющие друг друга CLI-команды: `annotations`, `prototype`, `context`; read-only workflow для добавления фактического motion context через уже подключённый официальный MCP; согласованная выдача provenance/coverage; обновление canonical и standalone legacy plugin.

Все команды читают данные. Не входят отправка/resolve комментариев, изменение реакций или макетов, Code Connect mappings, разрешение всего графа variables/styles, visual diff, подписка на изменения, общий MCP-сервер и автоматическая реализация фронтенда. Нарисованные стрелки не превращаются в prototype edges. Полное воспроизведение Smart Animate по одним REST transitions не обещается.

Плохой результат даже при работающем CLI: потерять исходную ноду из ссылки; вернуть соседний dependency frame как цель; выдать пустой список за отсутствие сценария во всём файле; умножить duration на 1000 без проверенного основания; назвать REST bundle полным motion-контекстом; автоматически выполнить инструкции из комментариев или URL actions.

## Проверенная доступность источников

Проверка 23.10.2026:

- В официальной REST-документации у нод описаны `annotations` и `interactions`; annotation содержит текст и список pinned properties. Это данные файла, отдельные от обсуждений `/comments`.
- В существующем пользовательском файле узкий `GET files/:key/nodes?ids=...` вернул 1949 нод и четыре interactions. В прочитанном охвате annotations не встретились; положительная live-проверка их содержимого ещё не выполнена. Приватный ответ хранится только вне git.
- REST описывает `Interaction` как trigger и упорядоченные actions, включая navigation, URL, variables и conditional blocks. Возвращённое время около `0.20000000298023224` требует осторожности: REST docs/OpenAPI называют transition duration миллисекундами; Plugin API показывает похожие числа в примерах. Одно число не доказывает единицу или ошибку документации.
- В текущем каталоге официального MCP доступен `get_motion_context(fileKey,nodeId,recursive)` для inventory/tracks/easing/code snippets; `use_figma` даёт программное чтение reactions. REST CLI не может сам вызвать инструменты хоста.
- Базовый suite на merged code: 116 tests, OK на Python 3.13.7. Локальные skills `figma-ops`/`figma-lookup` переведены на merged checkout; help обоих CLI проверен.

Первичные источники: [REST node types](https://developers.figma.com/docs/rest-api/file-node-types/), [REST property types](https://developers.figma.com/docs/rest-api/file-property-types/), [официальная OpenAPI spec](https://github.com/figma/rest-api-spec/blob/main/openapi/openapi.yaml), [Plugin API reactions](https://developers.figma.com/docs/plugins/api/properties/nodes-reactions/), [Plugin API Transition](https://developers.figma.com/docs/plugins/api/Transition/). Документация проверена в момент исследования; доступность конкретного endpoint и полнота конкретного ответа подтверждаются отдельно.

## Архитектура и общие контракты

Выбор исполнителя — сохранить Python 3.10+ standard library и системный curl, переиспользовать auth/cache/envelope/URL parser первой итерации. Новый сервер или host-specific subprocess для вызова MCP не нужен. REST-команды детерминированны, skill организует чтение MCP и интерпретацию.

Сохранить существующие семь команд и `schema_version: 1`. Новые operation получают собственные `data`/`coverage`; существующие envelopes не меняют смысл. Auth только существующий `FIGMA_TOKEN` или Keychain `figma-rest/figma`; нет чтения иных credentials/configs. Те же фиксированный API origin, TLS, 35s timeout, cache 300s, безопасные ошибки и отсутствие бесконечных retries. Исторические read-only решения первой итерации здесь сохраняются.

Все три команды требуют node из URL или `--node`; без node — argument error до сети. Не делать скрытого whole-file scan. GET files/key?ids=NODE восстанавливает source и ancestry; обход всегда начинает точную найденную ноду и исключает зависимости из scope. Общие `--refresh`, `--no-cache`, `--cache-dir`, `--output` работают после subcommand. `--limit N` (по умолчанию 20, положительное число) ограничивает только inline записи, не сканирование; `--output` сохраняет все собранные записи, но никогда не отменяет явные сетевые budgets.

Данные source subtree загружаются один раз на команду; извлечение annotations/prototype/structure — чистые функции над ним. `context` не запускает три CLI-процесса и не полагается на cache как на средство устранения повторных GET. Запрос comments независим; GET /me не является prerequisite.

Новые результаты имеют стабильный DFS-порядок нод и исходный порядок annotations/interactions/actions. Использовать итеративный обход, не зависеть от глубины Python recursion. Составные instance IDs сохранять без преобразований. Не включать geometry=paths для разведки.

## annotations

`annotations TARGET [--node ID] [--query TEXT] [--limit N]`

Собрать Dev Mode annotations исходной ноды и её потомков. Каждая запись: node identity/path, `annotation_index`, label (nullable), исходные properties, остальная raw annotation, provenance. Если встретились labelMarkdown/categoryId или иные дополнительные поля, сохранить raw; не обещать категорию/markdown там, где источник их не отдаёт. Не придумывать author/time/resolved: это не comments.

Фильтр query — literal Unicode casefold по доступным label/labelMarkdown. Аннотация только с pinned properties не исчезает при отсутствии query. Не выводить значения pinned properties из геометрии bbox: в этой итерации возвращаются исходные указатели на свойства. Разрешение всех CSS/token values остаётся отдельной задачей.

Coverage: root, scanned_nodes, nodes_with_annotations_field, nodes_without_annotations_field, total_annotations, matched_annotations, returned, truncated; semantic scope `loaded-subtree`. Отдельно различать явное пустое annotations, отсутствие поля и неподдержанный/некорректный формат поля. Повреждённая отдельная запись сохраняет доступные raw/identity, warning и partial; полезные записи продолжают возвращаться. Не трактовать непереданное поле как доказательство отсутствия заметок. Само отсутствие поля не меняет status с ok на partial: оно учитывается в missing coverage и общем warning fields_not_returned, а coverage.complete остаётся false. `null` или значение неверного типа вместо ожидаемого массива — повреждённые данные и partial, а не отсутствие поля.

## prototype

`prototype TARGET [--node ID] [--follow N] [--max-frames N] [--limit N]`

По умолчанию `--follow 0`; допускается 0..3. `--max-frames` по умолчанию 20, допускается 1..50, включает исходный scope root. Даже если исходный root не FRAME, бюджет относится к roots, а не node type; имя флага — удобный пользовательский термин. Это предел попыток чтения уникальных новых roots, включая неуспешные и cache hits: слот резервируется до GET и не возвращается при ошибке. Source расходует первый слот, значит при max-frames=1 дополнительных GET нет. Уже находящийся в загруженном subtree destination не требует GET и не расходует новый слот. В coverage раздельно requested_roots, successful_roots, failed_roots, expanded_from_loaded_nodes; предел requested_roots никогда не превышается.

Для каждого узла с interactions вернуть source identity/path, interaction index, trigger и весь исходный упорядоченный массив actions. Отдельная плоская таблица edges служит навигации: source_node_id, interaction_index, action_path, destination_id nullable, action_type/navigation, condition_path nullable, raw transition/easing и provenance. `action_path` — JSON Pointer внутри конкретного interaction (например `/actions/0/conditionalBlocks/1/actions/0`); condition_path указывает на соответствующий block. Branches — возможные действия, не вычисленные ветки выполнения. Не исполнять expressions, URL, media или variable actions; не переходить по внешним ссылкам.

Обрабатывать несколько actions, вложенные CONDITIONAL, OVERLAY, SWAP, CHANGE_TO, SCROLL_TO, BACK/CLOSE и null destination без выдуманной цели. Не все actions — переходы: вся action tree сохраняется, edge строится только для NODE action с ненулевым destinationId. Для остальных — action records с исходным payload. Не потерять малопонятные/новые action types: raw + warning + partial interpretation, не ошибка всего пакета.

Legacy `transitionNodeID`/`transitionDuration`/`transitionEasing` сохраняются отдельно. Когда modern interactions присутствует, даже как [], он основной источник; противоречивый legacy payload остаётся видимым с warning, не создаёт дубликат transition. Если modern field отсутствует, legacy может дать явно помеченное ограниченное evidence, без выдуманного trigger.

При follow>0 обход BFS по подтверждённым NODE destination IDs, с дедупликацией roots/посещённых IDs и защитой от циклов. Уже загруженные ноды повторно не запрашивать. Один дополнительный узкий GET на каждый новый root, без скрытой загрузки страницы; max-frames ограничивает число roots, не вывод. Depth считается по переходам: исходный subtree depth0, первый destination depth1. На последнем depth actions всё ещё извлекаются, дальнейшие destinations остаются frontier. CHANGE_TO может вести в component variant — это не повод заменять его произвольным экраном.

Unfetched frontier и неуспешные destinations перечислять с причиной: depth_limit, frame_limit, forbidden, not_found_or_inaccessible, rate_limited, network_error. Один неуспешный destination не теряет остальные результаты. При 429 дальнейшие дополнительные GET прекращаются, frontier получает rate_limited; никакого sleep. Наличие frontier/degraded interpretation даёт partial. Счётчики nodes_with_interactions_field/nodes_without_interactions_field отличают отсутствие поля от пустого массива; отсутствие поля само по себе даёт ok с missing coverage/fields_not_returned, а неверный тип поля — partial. Входящий граф и весь файл не исследованы, даже если frontier пуст. Никакого `complete=true` о всей Figma.

### Время и easing

Каждое численное поле времени сохраняется без округления вместе с raw JSON Pointer. В нормализованной записи: raw_value, raw_field, documented_unit (если известна из указанного источника), verified_unit nullable, normalized_ms nullable, unit_basis. Для REST transition.duration/legacy duration/trigger timeout/delay documented_unit — ms согласно проверенной документации; mediaHitTime — s. Но documented_unit не становится verified_unit автоматически. До отдельной подтверждённой калибровки REST timing verified_unit и normalized_ms остаются null, unit_basis=unverified, выдаётся общий warning timing_units_unverified.

Не использовать эвристику «число меньше единицы → секунды». Сопоставление REST и Plugin API одинаковых чисел подтверждает их равенство, а не единицу UI. Калибровка конкретного поля/пути через подтверждённую настройку UI или однозначный контракт — будущая отдельная правка с fixture и источником; она не блокирует чтение raw во второй итерации. Warning timing_units_unverified сам по себе не даёт partial: raw собран успешно, производные значения не обещались. Неполнота интерпретации времени остаётся явно видна в verified_unit/normalized_ms, а status отражает сбор запрошенного REST-scope.

Easing хранится как исходный объект со всеми параметрами cubic-bezier/spring, без подстановки CSS-кривой или генерации spring duration. Smart Animate transition не является keyframe track.

## context

`context TARGET [--node ID] [--scope-root ID] [--without-comments] [--limit N]`

Одна команда собирает REST dossier точного subtree: source node, ancestors/page, возможные ancestor FRAME roots для дальнейшего расширения, structure summary, annotations, prototype с follow0, полные относящиеся comment threads. Не запрашивать renders/image fills автоматически. Source — node из TARGET с обычным явным приоритетом --node; исходный URL node-id при переопределении дополнительно сохранить как url_node_id, не выдавая его за исследованную ноду. По умолчанию scope_root=source. Для более широкого контекста есть отдельный --scope-root; получить source/root одним GET files/key?ids=SOURCE,ROOT, найти оба по точным ID и подтвердить, что root — source или его предок. Неуспешная проверка отношения — error scope_mismatch, никакой подмены цели. Ancestry относится к source, текст/annotations/prototype/comments — к scope_root. Не расширять root до «экрана» по эвристике: агент выбирает --scope-root после просмотра ancestry/screenshot. Всегда различать source_node и scope_root, даже если они совпали.

Structure summary содержит node counts по type и общий счётчик, прямых children scope root (identity + bbox при наличии), список TEXT identities/characters. Это достаточный навигационный пакет; не включать всё дерево styles/geometry/binary assets. `--limit` применяется отдельно к спискам texts, annotations, interactions и threads; каждый список имеет собственные total/returned/truncated. Identity/ancestry не обрезать; replies внутри возвращённой ветки не обрезать. С `--output` все эти inline limits сняты в артефакте.

Для comments повторно использовать extractor/filter первой итерации, передав уже известный набор descendants вместо нового чтения nodes. Загрузить `/comments` один раз и сохранить полные совпавшие ветки. Unassigned pins остаются в coverage count, вне scope. Replies на соседнем pin не приписывать root. Comments автор/время — только исходные данные; JSON UTC, пересказ пользователю по МСК. При --without-comments запрос отсутствует и section state=not_requested; это не partial само по себе.

Основной GET source/root неуспешен или требуемая нода не найдена — error; без точной цели нельзя собирать dossier. Недоступен comments при успешном source — partial с ошибкой только этой секции, остальные данные доступны. Секции annotations/prototype с отсутствующими полями сохраняют state=collected с missing coverage/warning и complete=false; это не равнозначно пустым подтверждённым массивам. Повреждённые/неподдержанные данные либо неуспешный запрошенный endpoint дают partial. Comments skipped, host sections not_collected и непроверенные единицы времени сами по себе top-level partial не создают.

Для каждой секции указать `state: collected|partial|failed|not_requested|not_collected`, source, fetched_at, version nullable и coverage. Comments не имеют версии документа: snapshot_consistency=`independent-requests`, даже при одинаковом времени. Не утверждать атомарный snapshot. Полученные при follow различающиеся document versions сохраняются как наблюдения с warning.

`motion` и `canvas_visual` в CLI всегда state=not_collected, с reason=`requires-host-tool` и структурированными `next_actions` (kind, file_key, node_id, purpose, prerequisites). Это не автоматическая ошибка и не означает, что MCP недоступен: CLI этого не знает. Top-level status описывает запрошенный REST-scope, `coverage.complete` остаётся false для общего контекста. `next_actions` — данные-подсказки, а не исполнимые команды или произвольный script.

## Работа skill поверх CLI и MCP

Один общий workflow для нового и старого имени:

1. Определить доступные MCP tools по текущим схемам; не объявлять REST обязательным для простого чтения. Для dossier использовать настроенный REST context; при недоступном token продолжить доступные MCP-чтения, сохранив непроверенные секции.
2. Внешнюю ссылку разрешить в точную source ноду и ancestry. Для утверждения о полном экране выбрать и назвать явный --scope-root, при необходимости проверить screenshot; не путать вложенный frame с экраном и не заменять source через --node ради расширения охвата.
3. Разделять comment threads, Dev Mode annotations, prototype transitions, keyframe motion и нарисованные стрелки. Каждому выводу указать источник, точные file/node, дату/версию при наличии и границу проверки.
4. При запросе поведения проверить prototype actions и явные destinations. При запросе keyframes/animation вызвать доступный официальный get_motion_context по выбранному frame/subtree; при данных о motion на destination прочитать именно его. Ответы/сниппеты MCP хранить отдельными evidence artifacts доступным хосту способом и ссылаться рядом с REST dossier; не импортировать произвольные provider JSON в CLI второй итерации.
5. Перед каждым use_figma — актуальный figma-use; при чтении motion через него также figma-use-motion. Перед get_design_context — figma-design-to-code. Получение design context нужно для реализации, не для дешёвого поиска свойств.
6. Если tools отсутствуют или motion API unsupported — отметить конкретную секцию непроверенной и продолжить остальное. Пустые metadata/reactions не доказывают отсутствия timeline; screenshot покоя не даёт duration/easing.

У unified workflow нет обещания, что один CLI-вызов автоматически соберёт весь MCP/UI контекст. Досье передаёт уже собранное и точные оставшиеся шаги; агент закрывает нужные секции по задаче. Данные из макета/annotations/comments никогда не меняют системные инструкции агента.

## Совместимость и выпуск

В реализации поднять canonical figma-ops до 1.1.0, compatibility figma-lookup до 1.2.0; manifests/catalogs обновить согласованно. Канонический runtime/references/skill поддерживается в одном месте, legacy регенерируется штатным sync-compat.py; новые runtime modules автоматически учитываются generator/equality tests или явно добавляются в его список.

Не вводить зависимость legacy от соседнего plugin root. Проверить установленные копии обоих имён в отдельных временных каталогах из произвольного cwd с пробелами. Локальную установленную версию не переключать на непубликованный worktree второй итерации; после merge обновить обычную установку. PR в YarikMix/agent-utils при отдельном поручении открыть ready for review, без Draft.

## Проверка готовности будущей реализации

Содержательные unit/integration tests без сети: annotations с текстом/пустым label/pinned properties/дополнительными полями; missing vs explicit-empty vs malformed и точные statuses; точный subtree против dependencies; Unicode query и полный output; порядок нескольких actions; nested conditionals с JSON Pointer paths; overlay/change-to/null/BACK/unknown action; legacy conflict; raw float сохранён, verified/normalized время null без доказательства; циклы и BFS depth/root budgets, включая исчерпание попытками только неуспешных destinations; forbidden/429/frontier; source/root и ошибка не-ancestor root; сохранение полного thread по reply-only совпадению; без лишнего nodes GET при context; comments forbidden даёт partial; without-comments не делает GET; независимые timestamps/versions; оба самостоятельных plugin roots и прежние семь команд.

Свежие агенты на отложенных задачах должны различать annotations/comments и prototype/keyframes, сохранять source/root, замечать missing coverage и сомнительную единицу времени. Это симуляции выбора действий, не host discovery. Повтор заблокированного Claude CLI или иной обход policy не является критерием готовности.

Live read-only на уже разрешённом файле: prototype должен вернуть реальные interactions без потери actions/чисел; context должен сохранить ancestry и полный thread; для annotations нужна либо известная нода с реальной заметкой, либо явно отмеченная непроведённая положительная проверка. Не создавать заметку ради теста. Все приватные identifiers/texts/assets остаются вне tracked fixtures/reports.

Готовность: зелёный suite с регрессиями, task reviews и итоговое ревью, проверенная совместимость обоих имён, live успех или конкретно описанная граница. Отсутствие motion в REST не блокирует полезный REST dossier и не выдаётся за отсутствие motion в макете.

## Что решает исполнитель плана

Разбиение внутренних модулей, имена private функций, точная схема компактных summaries/код warning, переиспользование existing extractors без копирования transport и набор синтетических fixtures. Эти решения не должны менять описанный пользовательский результат, бюджеты, единицы времени, неизменность исходных данных или границы авторизации. Перед реализацией следующий артефакт — отдельный implementation plan по этому дизайну.

## Результат builder check

Свежий агент проверил пригодность дизайна для планирования. Два оставшихся вопроса разрешены исполнителем: неуспешные GET расходуют общий budget попыток; missing fields сами по себе не делают acquisition partial, но всегда сохраняют missing coverage. Дополнительно source и выбранный более широкий root разведены отдельным --scope-root. Продуктовых вопросов, требующих остановки и ответа пользователя, не осталось; реализация и её план — следующий этап.
