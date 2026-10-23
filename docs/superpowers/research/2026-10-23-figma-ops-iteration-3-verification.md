# Figma Ops: приёмка третьей итерации

Проверяется [спецификация bindings](../specs/2026-10-23-figma-ops-iteration-3-design.md).
Workflow и ограничения опубликованы в [Figma Ops README](../../../plugins/figma-ops/README.md)
и [bindings reference](../../../plugins/figma-ops/skills/figma-ops/references/bindings.md).
Canonical release — `figma-ops 1.2.0`, standalone compatibility — `figma-lookup 1.3.0`.
Установленные глобальные skills остаются на merged версии; незавершённая ветка
не устанавливалась. Push/PR/merge не выполнялись.

## Локальная проверка упаковки

- Packaging RED: пять test methods, шесть ожидаемых subtest failures — старые
  versions четырёх manifests и отсутствие `bindings.md` в двух roots.
- Packaging GREEN: пять tests OK. Каждый root копируется отдельно без sibling,
  запускается из cwd с пробелами через synthetic transport, без сети/Keychain.
  Фактически 11 базовых operations и 12 help calls на root: **22 operations,
  24 help calls** суммарно. Дополнительно шесть случаев на root: annotations
  partial, bindings definitions success/403, context bindings reuse,
  context definitions success/403; **12 дополнительных cases**, отдельно от base.
- Synthetic inventory проверяет точные source/root, component/style/variable IDs,
  used metadata вместо лишнего catalog, полные property keys и false/empty/SLOT.
  Записанные endpoint calls подтверждают один source GET, optional один Variables
  GET и context reuse без повторного source GET; полная ветка comments сохранена.
- Sync идемпотентен; 15 runtime modules в каждом root и все шесть references
  побайтово совпадают. Skill body одинаков, меняется только compatibility
  frontmatter; maintenance sync tool не входит в установленный legacy runtime.
- Полный `python3 -B -m unittest discover -s plugins/figma-ops/tests -v`:
  **282 tests OK** на Python 3.13.7 после final fix (`406baa7`, независимый
  controller run 6.207s). До final fix Task5 suite: 280 OK. `git diff --check` — пусто.
- AST `feature_version=(3,10)` — **31 Python-файл**: 15 canonical runtime,
  15 generated runtime и sync tool. Это проверка синтаксиса, runtime Python 3.10
  недоступен и не проверялся.
- Оба вызова системного `skill-creator/scripts/quick_validate.py` для canonical
  и compatibility skill roots: exit0, `Skill is valid!`; dependencies не ставились.

## Live read-only evidence контроллера

Проверки выполнены контроллером на ранее разрешённом участке с итоговым runtime `406baa7`; три CLI-проверки повторены после final fix.
Публикуются только technical counts. Точные file/node, payloads и значения
остаются в игнорируемых приватных artifacts, не в fixtures или этом отчёте.

| Чтение | Фактически подтверждено |
|---|---|
| Узкий `bindings` | exit0/ok; один source GET; source=root; 94 scanned nodes, 34 instances, 23 used components, 14 sets, 8 style usages, 5 styles, 84 binding rows, 20 unique variable refs, 3 mode observations; variables not_requested, single-response |
| Узкий `bindings --with-variables` | exit0/partial; ровно source + Variables GET; Variables HTTP403, причина неизвестна; тот же полезный inventory, 20 refs unresolved, variables version null, independent-requests; fallback/retry нет |
| `context --with-bindings` с явным ancestor root | exit0/ok; source сохранён, root расширен; ровно source + comments GET; 2575 scanned nodes, 906 instances, 78 used components, 32 sets, 424 style usages, 18 styles, 2611 binding rows, 67 unique refs; одна полная thread с двумя replies; variables not_requested |
| Отдельный официальный MCP `get_variable_defs` | Успех на том же точном source: 11 entries, значения строковые. ID/mode mapping не подтверждён; evidence отдельно, не импортировано в REST graph |

Live commands с `--limit 1 --output` сохранили полные collections, а не одну
запись, в приватных artifacts. На узком scope все 23 component definitions
`not_loaded`; на расширенном root одна definition — `loaded_dependency`, 77 —
`not_loaded`. Dependency не расширяет scanned scope. Дизайн не редактировался.

После final fix расширенный context сохраняет 38 null-reference raw observations
пустых wrappers; остальные 2573 rows содержат aliases. До исправления эти
наблюдения терялись. Они не создают variable IDs или partial, 67 unique refs
сохранены. Узкий scope по-прежнему возвращает 84 aliases и 20 unique refs.

Положительный Variables REST, alias closure этого endpoint, SLOT и extended
collections не проверены live: для них нет доступного подходящего источника.
Они проверены synthetic fixtures. MCP строки не подтверждают наличие всех
modes/IDs и не дают основания вычислять effective values.

## Native routing и пределы оценки

OLD snapshot skill/references заморожен до правки текста. Контроллер использует
шесть отложенных synthetic retrieval/application scenarios; их тексты, IDs,
values и приватная rubric не включены в продуктовые examples или fixtures.
Evaluator выбирает действия и не исполняет tools: это simulation маршрутизации,
а не доказательство activation/discovery установленного skill в Claude Code/Codex.

OLD сохранял границы ID/key/fileKey, used metadata, raw modes/aliases,
раздельные REST403/MCP evidence и partial/artifact/budget. В content-only dossier
он выбирал прежний context, допускал comments partial, затем проверял новый
bindings help и отдельный inventory, поскольку новый opt-in contract ему не был
известен. Это описательное наблюдение, не выдуманный RED или количественный gain.

Fresh NEW завершён контроллером после freeze canonical/generated skill и шести
references на том же отложенном наборе, без доступа к OLD/report/private rubric.
В пяти сценариях защитные границы сохранены обеими версиями. В content-only dossier
NEW явно выбирает context с исходным source и ancestor root, `--with-bindings
--without-comments`, без variables: один source GET без отдельного inventory,
comments или Variables GET. Это описательное упрощение выбранного маршрута,
а не измеренное улучшение исполнения и не выдуманный fail-to-pass.

В замороженной копии evaluator нет installed scripts; вычисленный им путь CLI
относительно scratch не проверяет наличие или запуск инструмента. Фактические
пути автономного CLI отдельно проверяются packaging suite. Обе native оценки —
simulation, host activation/discovery ими не подтверждены. Количественный gain
или измеренная экономия tokens/time не заявляются.

Все пять task reviews завершены. Whole-branch review охватил исходную spec и
диапазон от merge base до выпуска. Найден один Minor: потеря raw binding
container с одними пустыми wrappers. Он исправлен в `406baa7`, две новые
регрессии прошли RED→GREEN, единственный scoped re-review подтвердил ADDRESSED
и отсутствие новых дефектов. Открытых или отложенных findings нет.

Независимая controller suite после исправления: 282/282 OK, включая 22 base
operations, 24 help calls и 12 дополнительных standalone cases. Повторный AST
проверил 31 файл; 15 runtime modules каждого root идентичны. Skill/references
не менялись после frozen NEW и двух успешных validators.

Controller проверил 44 изменённых tracked-файла по 17 известным private/held-out
идентификаторам: совпадений нет. Это проверка заданного набора идентификаторов,
а не доказательство отсутствия любых возможных чувствительных данных.

## Принятые границы итогового ревью

Reviewer отдельно перечислил три явно исключённые возможности; контроллер
принял каждое исключение по исходной spec:

1. Effective modes, alias values и полный inherited instance diff остаются вне
   evaluator. Цена, если объём выбран неверно: вычисленные значения и inherited
   diff потребуют отдельной итерации; текущий результат даёт evidence.
2. Полный resolver с загрузкой remote libraries/других files не добавляется.
   Цена, если неверно: недоступные удалённые definitions остаются unresolved
   до отдельного чтения.
3. Создание Code Connect mappings и запись в Figma не добавляются к read-only
   scope. Цена, если неверно: создание mappings и изменения дизайна потребуют
   отдельного поручения/итерации.

Иных controller rulings, parked findings или deferred minors нет. Ветка
`figma-ops-iteration-3` и worktree сохраняются. Временные приватные payloads,
снимки routing и служебные отчёты текущего плана удаляются при завершении;
санитизированный результат и реализация остаются в git. Установленная версия
остаётся на merged main до следующего merge.

## Границы разрешений

Credentials/auth/cache/TLS/timeout contracts не менялись. Локальные tests
используют только synthetic transport. Live reads контроллера не создавали
Code Connect mappings, не меняли comments, variables или макет.
Публичная OpenAPI была доступна после явного разрешения пользователя на curl;
это не разрешает повторять исторически отклонённый child CLI inference.
Такой retry/bypass в этой работе не выполнялся.
