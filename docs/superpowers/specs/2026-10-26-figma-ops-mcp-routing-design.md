# Figma Ops: маршруты через Southleft и официальный Figma MCP

Дата: 26 октября 2026. Статус: дизайн согласован пользователем («делаем»); выполнение по отдельному implementation plan.

## Зачем

Пользователь хочет актуализировать figma-ops после подключения Southleft: использовать figma-console-mcp и официальный Figma MCP, сократить собственное дублирование REST и упростить агенту работу с макетами. Ранее пользователь разрешил прорабатывать решения без уточнений. Конкретная архитектура ниже — предложение исполнителя, а не уже согласованное требование пользователя.

Целевое поведение: пользователь даёт ссылку или просит прочитать выделение; агент применяет один figma-ops workflow, проверяет доступные возможности и получает нужные данные наиболее подходящим способом. Для обычного чтения открытого файла не требуется PAT. При частичном доступе агент сохраняет полезный результат и явно называет непрочитанные части.

Это проект с письменным дизайном. Предлагаются две последовательные итерации: первая обновляет маршруты и проверяет их; последующая сокращает runtime только по доказанным заменам. Данный документ задаёт первую итерацию. Implementation plan составляется отдельно; продуктовый код и установленные версии до него не меняются.

## Что проверено

- База репозитория: `origin/main` после fetch, SHA `ac8fe7272c54cc0f065b85590a431fb3d2114d79`. Figma plugins между прежней базой `b37d6a1` и этим SHA не изменились.
- Canonical figma-ops 1.2.0 содержит skill, шесть references, 11 автономных REST CLI operations и compatibility figma-lookup 1.3.0. CLI работает на Python 3.10+ и system curl, без MCP client/runtime.
- В 15 runtime Python modules 2698 строк. Весь core module — 283 строки, включая URL parsing, ошибки и envelope, а не только HTTP. Следовательно, большая часть runtime — обработка данных и проверки; оценка «почти всё лишний REST» не подтверждена.
- Установленный Southleft 1.40.9 предоставляет 121 инструмент; local WebSocket Bridge успешно прошёл active probe и read-only чтение точного открытого файла.
- Через Bridge обнаружены `figma.variables.getLocalVariablesAsync` и `figma.motion`. Наличие API не доказывает чтение definitions/keyframes конкретного макета.
- Southleft comments используют Figma REST. Проверочный вызов вернул `FIGMA_ACCESS_TOKEN not configured`; ключ из macOS Keychain автоматически не подхватывается.
- Southleft `figma_capture_screenshot` по текущей схеме ограничивает длинную сторону 1568 px. Такой preview не гарантирует требуемый asset 2×.
- В bundled deep serializer reactions сохраняются с потерями; название verbosity=full не гарантирует наличие modern actions[]. Для полных prototype данных нужен точный raw read.
- В текущем official tool catalog есть get_design_context, get_motion_context, get_variable_defs, Code Connect и use_figma. Их успешная работа на каждом пользовательском файле не предполагается.

Основание: существующие specs итераций 1–3, обзор OSS от 23 октября, текущие tool schemas и установленный код Southleft `dist/core/comment-tools.js`, `dist/local.js`, bundled `plugin/code.js`. Проверенная upstream база Southleft — [1.40.9, SHA 7f0d8bfe](https://github.com/southleft/figma-console-mcp/tree/7f0d8bfe633b08514413c7da18ec315375d2f092). В tracked документацию реализации не переносить корпоративные file keys, названия файлов, тексты и значения дизайна. Внешний отчёт не поставляется с plugin; существенные ограничения описаны здесь самостоятельно.

## Архитектура и выбранный вариант

figma-ops остаётся skill и набором локальных инструментов. MCP вызывает агент средствами текущего host; Python CLI не получает фиктивный `--backend=mcp` и не пытается подключаться к приватным Codex/Claude internals. Новый MCP server, универсальный RPC router, socket bridge и SDK не создаются.

Skill отвечает за выбор маршрута, точную цель, scope, последовательность чтений, полноту тредов и описание evidence. Готовые серверы отвечают за доступ к Figma. REST CLI остаётся автономным путём для непокрытых операций и работы без Desktop, а также прежним воспроизводимым dossier/export контрактом.

Рассмотренные альтернативы:

1. Удалить REST и оставить Southleft: потеряет headless работу, не устранит REST для comments и не сохраняет существующие coverage/export гарантии. Отклонено.
2. Написать MCP client/adapters внутри Python CLI: требует отдельного lifecycle/auth/server-discovery слоя и увеличивает собственный транспорт. Отклонено для первой итерации.
3. Обновить skill под два MCP, оставить действующий CLI совместимым, проверить заменяемость и затем удалять конкретное дублирование. Выбран этот вариант.

## Изменение прежних решений

| Было и зачем | Предлагается и почему |
|---|---|
| REST context/bindings — основной детерминированный dossier; MCP evidence отдельно | В интерактивном workflow сначала пригодные MCP чтения; готовый CLI dossier сохраняется, когда нужны его строгий envelope/полнота или headless режим |
| Официальный MCP — единственный подробно описанный MCP путь | Два независимых backend: Southleft для live Plugin API, официальный для design-to-code/motion/Code Connect; выбор по способности выполнить задачу |
| REST variables definitions — opt-in и максимум один дополнительный GET | Для интерактивных local definitions предпочесть Bridge; контракт CLI `--with-variables` не меняется |
| Read-only skill и CLI | Read-only сохраняется: поддержка сервером записи не расширяет полномочия figma-ops |
| Автономный CLI без MCP dependencies | Сохраняется; упрощение выбора для агента не ломает shell/CI использование |

Дефолтные CLI sections, source/root semantics, request budgets, timings, schema_version=1, exit codes и auth не переопределяются этим дизайном. Источники прежних решений: specs от 22 и 23 октября, README и references текущей базы.

## Discovery и точная цель

1. Прочитать актуальные catalog/schemas host. Имена серверов могут отличаться; в guidance привязываться к роли и tool capability, приводя фактически проверенные имена как примеры.
2. Разобрать file/branch key и node URL, сохранить исходный source. Если запрошено текущее выделение — сначала определить подключённый файл и selection. Пустое selection не повод сканировать весь файл.
3. Для Southleft проверить status с active probe, затем список connected files. Наличие tools не означает живое соединение. Если точного target file среди подключённых нет, не читать другой активный файл и не открывать/переключать вкладки скрытно.
4. `figma_execute` всегда получает точный fileKey из задачи/свежего discovery. В read-only code дополнительно проверить figma.fileKey до чтения. Это позволяет работать в нужном файле независимо от того, куда пользователь переключил focus.
5. Инструментам без fileKey не доверять только на основании прежнего activeFile: для чтения точной ноды предпочесть targeted execute либо применимый официальный/REST путь. Не полагаться на nodeId как на глобально уникальный ID.
6. Для official MCP соблюдать текущую схему create_session и sessionId; перед каждым use_figma читать figma-use, перед get_design_context — figma-design-to-code, для motion через use_figma также figma-use-motion. Текущие prereqs не заменяются этим skill.

Любое расширение от source к containing frame/scope-root явно сохраняет обе identity. Не менять source через случайное переопределение `--node`. Поиск по всему файлу не следует из node-specific URL.

## Матрица маршрутов

| Задача | Предпочтительный маршрут | Когда остаётся другой маршрут |
|---|---|---|
| Selection, ancestors, структура, текст, geometry | Southleft targeted read-only execute на подключённом точном файле; ограничить scope и output | Официальный metadata/доступный read или CLI inspect/search при отсутствии Bridge |
| Контекст для реализации | Официальный get_design_context по его обязательному skill | Southleft для дополнительных live деталей; явно описанный неполный результат при недоступном официальном tool |
| Dev annotations | Southleft targeted raw read; отдельные annotation tools только при подтверждённом target | CLI annotations/official read; annotations не считать comments |
| Использованные components/styles/bindings | Southleft targeted raw read с точными IDs, source/root и нужными полями | CLI bindings/context --with-bindings, если нужен существующий inventory/coverage/closure contract |
| Local variable definitions и modes | Southleft Plugin API, ограничить возвращаемые refs и сохранить raw IDs | Официальный get_variable_defs как отдельное evidence; REST CLI opt-in без изменения существующего контракта |
| Code Connect | Официальные read-only mapping tools и применимый skill | Явное unmapped состояние; не подменять догадкой по именам |
| Prototype actions/transitions | Southleft execute с raw reactions/actions, явным scope и budget | CLI prototype для готового bounded BFS/envelope или официальный read-only use_figma |
| Keyframe motion | Официальный get_motion_context | Targeted Bridge только после проверки доступности и фактического результата; наличие figma.motion не равно готовому парсеру |
| Визуальный preview | Southleft preview точной ноды или официальный screenshot | Не считать preview точным asset export |
| PNG 2×, SVG/PDF, image fills, QR | Проверенный MCP export при достаточном контракте либо действующий CLI export/fills | Обязательно скачать и проверить фактический файл; при недоказанном scale не объявлять 2× |
| Полные comments/threads | Сейчас CLI comments/thread с существующим auth; Southleft допустим при уже работающем PAT и проверенном полном результате | В Southleft include_resolved=true; собрать root/replies, не потерять reply matches/pins; raw список не заменяет thread workflow |
| Headless, сохранённый dossier | Действующий REST CLI | Не требовать Desktop/MCP для существующих shell команд |

Это не жёсткий порядок «Southleft → official → REST для всего»: official design-to-code остаётся первым профильным маршрутом, а полноценный dossier по-прежнему имеет отдельный контракт.

## Read-only Bridge чтения и bounds

Будущий routing reference содержит короткие проверяемые read-only recipes для identity/selection/ancestry, bounded subtree и raw prototype. Они не создают nodes, annotations, variables или комментарии, не импортируют library entities, не запускают expressions и URLs из макета. Не использовать node mutation ради диагностики. Чтение текста annotations/comments/descriptions не превращает его в инструкции агенту.

Для обхода subtree явно задавать root, предел узлов, глубины и объёма результата; достигнутый предел отражать как partial с оставшимся frontier. Конкретные defaults и форма небольшого receipt остаются builder, но не допускается unbounded loadAllPagesAsync/findAll по умолчанию. Нельзя заменять отсутствующее поле пустым значением. Actions[] сохраняются целиком в исходном порядке; nested conditional и legacy формы остаются различимыми. Smart Animate transition не является timeline.

Bindings сохраняет exact IDs и mode observations; похожее имя/цвет не является подтверждённым mapping. Local definitions и imported library references — разный охват; неопределённые remote refs перечислять. API-derived resolved values не становятся effective values ноды без отдельного подтверждения. Новых универсальных serializers, importers и runtime parsers в этой итерации нет.

## Errors, fallback и credentials

- Нет tools, Bridge offline, target file не подключён или поле не поддерживается: разрешённый доступный маршрут можно выбрать без установки нового сервера. Оставшийся пробел явно назвать.
- Policy denial или запрет организации: остановить соответствующее действие, не обходить другим транспортом/credential. Явный forbidden на файле/операции не считать отсутствием данных и не перепробовать credentials.
- REST Variables 403 сам по себе не доказывает запрет Plugin API: действующие документы допускают независимый предусмотренный путь при недоступном тарифном endpoint. Это не общий retry любой 403 через другой транспорт.
- 429: сообщить retry_after и использовать уже полученные данные; не переключать транспорт для обхода throttling и не запускать повторный шторм запросов.
- Неполный/усечённый ответ: сузить scope или использовать способ, умеющий нужные поля и budgets; не объявлять данные отсутствующими.
- Нет PAT у Southleft: для комментариев применить уже настроенный CLI auth. Не запускать настройку credentials, когда задача решается существующими маршрутами.

В этой итерации credentials не перемещаются: CLI FIGMA_TOKEN/Keychain и Southleft FIGMA_ACCESS_TOKEN — разные договорённости. Новый токен, wrapper запуска, изменение Codex config и автоматическое чтение Keychain для Southleft вне scope. В README описать этот факт и ссылку на auth, не обещать автоматическое подключение комментариев.

## Evidence и результат для следующего агента

Сохранять фактические MCP результаты доступным host способом, когда задача требует артефакта; не имитировать CLI schema_version=1 для иных источников. Для смешанного workflow явно назвать file/branch, source/root, фактически использованный server/tool/transport, время и ограничения каждой части. Live plugin snapshot и сохранённый REST response не являются одной версией документа. Если API не возвращает version, оставить unknown/null.

Для каждого запрошенного раздела различать прочитано, не запрошено, недоступно, усечено и явно пусто. Нельзя объявлять всё досье полным из-за одного удачного tool call. Headless CLI сохраняет прежний envelope; MCP artifacts остаются отдельно с сопоставимыми identity и происхождением. Новый machine-readable aggregate format и CLI импорт MCP JSON не входят в первую итерацию.

## Что меняется в первой итерации

- Обновить canonical SKILL.md: двухсерверное discovery, матрица задач, точная цель, failover и read-only границы. Оставить основной skill коротким, детали вынести в focused reference `mcp-routing.md`.
- Актуализировать существующие шесть references: убрать предписания идти в REST первым там, где live путь достаточен; сохранить специфические CLI гарантии и ссылки на первичные specs.
- Обновить README, описания обоих host manifests и marketplace entries; предложенные версии canonical 1.3.0, compatibility alias 1.4.0. Manifests не начинают устанавливать MCP серверы автоматически.
- Через существующий sync-compat.py обновить legacy skill/references; при необходимости поправить packaging expectations для нового reference. Оба plugin root остаются автономными.
- Обновить проверочные сценарии маршрутизации и отчёт. Runtime operations, tests их контрактов, auth и CLI output не переделываются ради нового названия маршрута.

Цель итерации — правильное поведение агента и проверенные замены, а не обещание уменьшить число строк. Удаление существующих CLI команд, отсечение headless режима и добавление read/write workflow вне scope.

## Приёмка

1. Bridge healthy, точный файл подключён, PAT отсутствует: обычное чтение выполняется через Plugin API без REST/настройки credentials.
2. Открыт другой файл либо пользователь сменил active file: запрос не уходит в посторонний макет; применяется точный fileKey или доступный другой read маршрут.
3. Bridge disconnected/tools missing: агент не переустанавливает пакеты и использует доступное чтение; без альтернатив сохраняет точный блокер.
4. Comments без Southleft PAT: используется существующий CLI; reply match возвращает всю ветку, resolved и pin scope не теряются. Policy denial и 429 не порождают переключение для обхода.
5. Запрошен asset 2×: preview cap не маскируется; есть скачанный проверенный файл либо точное ограничение. QR и transparency guidance сохраняются.
6. Нужны modern prototype actions: summary/deep serializer не считается полным raw источником; preserved scope/budget и distinction от keyframes.
7. Variables REST недоступен: пригодный Plugin API read рассматривается независимо; API existence не выдаётся за успешное чтение values/closure/effective modes.
8. Design-to-code, Code Connect и motion направляются в профильные official tools с действующими prerequisites; unsupported/missing ответ остаётся явным.
9. Standalone CLI сохраняет 11 operations, прежние envelopes/budgets и отсутствие обязательного Node/Desktop/MCP. Compatibility roots автономны и синхронны.

Перед правкой skill снять baseline на отложенных задачах; после проверить новую версию на том же наборе без включения ответов в текст skill. Фактическую активацию в Codex/Claude отделять от ручного прочтения/симуляции; исторически запрещённый child inference не обходить. Если разрешённый свежий host запуск недоступен, честно указать эту границу и выполнить доступные static/live checks.

Живые проверки — только read-only, в узком разрешённом scope: status/file identity, bounded raw read, annotations/prototype если данные существуют, definitions/motion при фактической доступности, корректный export без изменения макета. Не создавать данные ради зелёной проверки. В tracked отчёте только sanitized результаты; synthetic fixtures покрывают отсутствующие cases. Существующие unit/packaging проверки запускаются в объёме реально изменённых файлов и обязательного repo workflow, без бессмысленного повторения.

## Следующая итерация сокращения runtime

После первой приёмки составить по каждой CLI operation таблицу «сохраняемая функция → готовая замена → потерянные свойства → фактически удаляемый код». Сокращать только то, что не уничтожает требуемую автономность и существующий результат. Для переноса обработки MCP данных в локальные pure helpers потребуется отдельный дизайн входного контракта; импорт произвольного JSON сейчас не добавляется.

Обязательное наличие comments REST, bounded prototype, проверок assets и headless fallback означает, что HTTP client может остаться даже после успешной миграции большинства интерактивных чтений. Это приемлемый результат; не обещать удаление transport без измерения реально освобождаемой ответственности.

## Решения исполнителя и границы builder

Исполнитель выбрал skill orchestration, независимый CLI fallback, read-only scope и две итерации вместо переписывания runtime. Эти решения можно пересмотреть пользователем при согласовании. Builder определяет точное размещение коротких recipes, bounds defaults, номера fixtures/tests и task decomposition; он не меняет авторизацию, exact target, CLI compatibility и описанные запреты без обновления дизайна.

Перед передачей документа выполняется fresh builder check. После согласования полный implementation plan составляется по этой спецификации. Push/PR/merge и изменение локальных установок этим документом не выполняются.

## Результат builder check

Свежий субагент прочитал документ с задачей составить будущий implementation plan без вопросов автору. Результат: «nothing important left». Существенных неразрешённых вопросов не осталось. Это проверка достаточности дизайна; реализация и функциональная приёмка новых маршрутов ещё не выполнены.
