# Figma Ops: проверка MCP routing

Проверяется [утверждённая спецификация](../specs/2026-10-26-figma-ops-mcp-routing-design.md).
Маршруты опубликованы в [Figma Ops README](../../../plugins/figma-ops/README.md)
и [MCP routing reference](../../../plugins/figma-ops/skills/figma-ops/references/mcp-routing.md).
Canonical release — `figma-ops 1.3.0`, автономный compatibility alias —
`figma-lookup 1.4.0`. Упаковка согласована для Claude Code и Codex.
Это первая итерация routing: действующий CLI не удалён и автоматически не
переключается на MCP. Установленные plugins/config/credentials не менялись;
push/PR/merge не выполнялись.

## Synthetic и файловые проверки

Packaging expectations сначала обновлены на новые версии и семь references.
До manifests/sync запуск `python3 -m unittest discover -s plugins/figma-ops/tests -p test_packaging.py -v`
завершился exit 1: `Ran 5 tests in 6.264s`, `FAILED (failures=5, errors=1)`.
Четыре version subtests не совпали, alias reference-set не содержал
`mcp-routing.md`; existing byte-copy test получил ожидаемый FileNotFoundError
этого отсутствующего файла. Остальные две test methods проходили.

Затем существующий `sync-compat.py` вывел:
`Synchronized 15 runtime modules and standalone skill/references.`
Alias skill/references генерируются, canonical instructions не правятся упаковкой.
Полный `python3 -m unittest discover -s plugins/figma-ops/tests -v`
запущен один раз после упаковки: exit 0, `Ran 296 tests in 7.357s`, `OK`.
Это прежние 282 теста и 14 новых recipe tests, без skipped/failures/errors.
По каждому root напечатано:
`11 base operations, 12 help calls, 6 additional enrichment/partial/context cases`.
Всего **22 base operations, 24 help calls, 12 дополнительных cases**.
Packaging проверил оба hosts, семь references в каждом root, одинаковое тело
skill, byte copies и идемпотентность sync в temporary tree. Maintenance script
не копируется в legacy. Каждый root запускается отдельно из cwd с пробелами,
без sibling plugin, с synthetic transport, без сети/Keychain.

Отдельная статическая проверка: все 6 JSON parse успешно; 4 manifests согласованы
с Figma entries обоих catalogs, каждое non-Figma entry осталось прежним.
Все **30/30 runtime modules** byte-identical к HEAD, **15/15 pairs** совпадают
между roots; runtime auth и sync tool не изменены. `sync-compat.py` отсутствует
в legacy runtime. Проверены **88 local links в 19 Markdown files** — все
разрешаются внутри репозитория. `git diff --check` завершился exit 0, output пустой.
Полный suite повторно без новых изменений поведения не запускался.

Новые synthetic tests исполняют опубликованные JS recipes из reference против
контролируемого Plugin API fixture. Они проверяют guard до доступа к чужому файлу,
composite IDs и ancestry, пустое selection без scan, точный root без sibling
expansion, node/depth/UTF-8 byte limits и frontier, source/root identity,
missing/empty/false/zero, raw nested/unknown/legacy actions, lazy children,
missing node и недостаточный receipt budget. Fixtures не доказывают фактическую
поддержку каждого поля живым Figma API и не являются live успехами.

## Live read-only evidence контроллера

Контроллер выполнил разрешённые чтения в узком подтверждённом scope.
Здесь только sanitized technical counts: file/node IDs, тексты, значения,
геометрия, private payloads и изображения не публикуются. Макет, selection/page,
comments, mappings и variables не менялись; library entities не импортировались.

| Проверка | Фактически подтверждено | Граница |
|---|---|---|
| Southleft active status probe | Успех | Наличие tools отдельно не считалось соединением |
| Опубликованный identity/ancestry recipe | Успех; selection/node/ancestors, scopeNodes=3, partial=false | Только подтверждённый точный файл и target |
| Опубликованный bounded subtree recipe | Успех; 7 nodes, partial=true, depth_limit, receipt 11581/32768 bytes | Достигнут предел глубины, whole-file completeness не заявляется |
| Raw fields на прочитанном участке | Annotations и reactions поля наблюдались у 7 nodes, массивы пусты; bindings у 4 nodes | Положительные annotations/actions проверены synthetic, пустота относится только к участку |
| Variables API read | Все 4 уже наблюдённых remote refs вернули definitions и mode values | Без импорта; не подтверждены полный local catalog, collection/alias closure или effective values конкретной ноды |
| MCP export и проверка скачанного файла | PNG, фактический размер ровно 2× source, прозрачные пиксели подтверждены декодированием; warnings=[] | Это отдельный asset check, не вывод из preview cap/scale parameter; размеры и изображение приватны |
| Motion | API surface доступен | Реальные tracks/keyframes не читались; API existence не является положительным motion результатом |

Успех export не подтверждает SVG/PDF/fills/QR на живом источнике.
Полный comments/thread workflow, official design-to-code/Code Connect/motion,
offline/missing tools, target-switch races, policy denial и throttling в этой
итерации не получили live positive coverage. Для comments/CLI есть прежние
synthetic контрактные проверки, для маршрутизации — application evaluation.
Данные не создавались ради положительного теста.

## Application evaluation и host activation

Baseline skill/references заморожены до правки. Контроллер сохранил отдельно
девять held-out сценариев и сравнил новую application evaluation с закрытыми
ожиданиями. Новый evaluator явно прочитал актуальные файлы, без expected checks,
не вызывал реальные tools и не проверял установленный plugin. Controller
не нашёл важных расхождений: exact-file guard, selection identity, проверенный
asset, полная thread с существующим CLI auth, bounded raw actions, независимый
Plugin API после тарифного Variables REST 403, official prerequisites,
остановка policy/429 bypass и раздельный provenance сохраняются.

Тексты/конкретные targets/ответы held-out задач не включены в plugin examples
или fixtures. Baseline evaluator видел rubric и сам верно выводил часть маршрутов:
это не blind baseline и не failed runtime trace. Количественный before/after gain,
экономия времени/токенов и формальный host RED/GREEN не заявляются.

Это проверка применения явно прочитанных инструкций, а не реального
activation/discovery в свежем Claude Code/Codex. Fresh external child inference
ранее был запрещён policy, поэтому не запускался повторно и не обходился другим
способом. Live recipe/export evidence независимо подтверждает только
выполненные разрешённые чтения, не host activation.

## Границы результата

Оба plugin root должны сохранять 11 operations, прежние `schema_version=1`,
exit codes, budgets и headless работу без Node/Desktop/MCP. Southleft
`FIGMA_ACCESS_TOKEN` и CLI `FIGMA_TOKEN`/Keychain остаются разными контрактами;
автоматического переноса credentials или установки серверов нет.
MCP payloads не импортируются в CLI envelope и не получают общую фиктивную
версию документа с REST. Результаты с partial/frontier не объявляются полными;
явно пустые fields не заменяют unavailable/unsupported sections.

Самостоятельность packaging проверяется двумя isolated roots с synthetic
transport: это не обещание, что live API вернёт тот же payload или что каждый
хост уже обнаружил новую редакцию skill. Оставшиеся пробелы перечислены выше.
