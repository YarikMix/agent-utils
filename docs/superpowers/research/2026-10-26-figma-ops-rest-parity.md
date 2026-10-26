# Figma Ops: что можно заменить готовыми MCP

Срез после merge PR #16: `origin/main` SHA `4623096`. Canonical figma-ops 1.3.0, alias 1.4.0. Проверены исходники всех 11 operations, общий Client и используемые collectors; это audit зависимостей, не новый live benchmark. Установка обновлена: шесть skill links ведут в merged checkout, README/manifests согласованы, оба установленных CLI проходят help из другого cwd.

## Замены по операциям

| CLI operation | REST-запрос и сохраняемая функция | Готовая MCP замена | Что мешает удалить операцию / код |
|---|---|---|---|
| doctor | GET /me, проверка именно REST identity/auth | Southleft status/probe проверяет Bridge | Это другая проверка; probe не доказывает работоспособность PAT |
| inspect | GET /files/:key, точная нода, ancestry или каталог страниц | Targeted execute/identity recipe, official metadata | Интерактивный путь заменён; shell без Desktop по-прежнему использует loader |
| search | GET /files/:key с явным page/node, literal casefold, path/coverage | Targeted Plugin API search в нужном scope | Готового эквивалента всего standalone search contract не проверено; bytes/depth caps live read не равны полному поиску |
| comments | GET /files/:key/comments, полные threads + query/pin/status | Southleft get_comments с include_resolved=true | Southleft сам использует REST/PAT, отдаёт raw comments; группировка/фильтры/полные replies остаются потребителю |
| thread | Тот же comments GET, lookup по root или reply | Raw comments Southleft + сбор ветки | Прямой проверки эквивалентности root/reply/orphan semantics нет; отдельного token-free Plugin API пути не найдено |
| annotations | Узкий files GET, scoped raw annotations, missing coverage | Targeted raw read / get_annotations | Live чтение доступно, но shared load_scope нужен другим CLI operations и headless сценарию |
| prototype | Узкий files GET + bounded BFS destinations, raw actions/timings/frontier | Raw reactions через execute; официальный motion отдельно | Summary/deep serializer не заменяет modern actions; bounded raw subtree не заменяет весь BFS и timing contract |
| context | Shared node GET + comments + optional variables, независимые sections | Несколько MCP reads + artifacts | Нет готового общего dossier contract; REST context по-прежнему нужен без Desktop и для воспроизводимого envelope |
| bindings | Node GET + optional /variables/local, used entities, aliases/modes/closure | Plugin API + official variable defs/Code Connect | Чтение definitions заменяет тарифный endpoint в live workflow, но не весь inventory/closure/provenance contract |
| export | GET /images/:key + скачивание, pixel/format checks, overwrite rules | Native exportAsync через targeted execute | Native 2× PNG проверен в прошлой итерации; сохранение и проверка ещё выполнялись разовым host-кодом. Headless render всё ещё нужен |
| fills | Node GET + GET /files/:key/images + source download | Plugin API getImageByHash/getBytesAsync для доступных image refs | Источники image fills не равны render ноды; полного live parity не проверяли |

## Реально удаляемый код

В canonical runtime 2698 строк в 15 modules. Общий `Client` занимает 115 строк: `_request` 38, `get_json` 52, `download` 9, `_credentials` 4, constructor 7; остальные строки — оформление класса. Весь `figma_ops_core.py` 283 строки включает URL parsing, errors, atomic writes и envelope, а не только REST.

При сохранении текущих 11 headless operations ни один из шести GET endpoint templates не становится неиспользуемым. Удаляемых transport methods **0**: Client нужен comments, exports/fills и standalone node/variables reads. Удаление GET /me сократит doctor, но лишит проверки REST identity; это изменение поведения, а не мёртвый код. Удаление collector не следует из замены его fetch: это разные обязанности.

Две копии runtime — цена автономного alias packaging, выбранного в первых итерациях. Общий внешний package сократит repository copies, но добавит installation/runtime dependency. Текущий audit не доказывает, что такая миграция выгодна.

Сохранение headless/standalone — согласованный выбор предыдущей итерации, а не неизменяемое свойство продукта. Если отказаться от него, можно спроектировать breaking 2.x с optional REST companion; это отдельное решение о поведении и совместимости, его нельзя выдать за безопасное удаление дубликатов.

## Проверка текущей доступности

В этой сессии active probe Southleft вернул `serverRunning=true`, `available=false`, `No active file connected`. Поэтому новые live parity результаты не заявляются. Не выполнялись переключение/перезапуск Figma, изменение дизайна, перенос credentials или попытки обхода через другие MCP instances.

Историческое положительное evidence PR #16: published identity/subtree recipes, native downloaded PNG с подтверждённым 2× и прозрачностью, четыре уже доступные variable definitions. Положительных live keyframes/annotations/prototype actions/fills не получено; они не считаются закрытыми по наличию инструментов.

## Рекомендуемая следующая итерация

Сделать native PNG export штатным проверяемым сценарием: targeted read-only export recipe + автономная локальная проверка файла через существующий `inspect_image`, без REST/PAT. Это устраняет разовые private-module вызовы на стороне host и снижает необходимость возвращаться к REST для интерактивного экспорта. Runtime не станет короче; результат оценивается по отсутствию лишнего REST в этом workflow и сохранению проверки файла, а не по числу удалённых строк.

Variable recipes, motion implementation, auth wiring, общий MCP importer и breaking removal CLI в эту небольшую итерацию не включаются. [Следующая спецификация](../specs/2026-10-26-figma-ops-native-assets-design.md).
