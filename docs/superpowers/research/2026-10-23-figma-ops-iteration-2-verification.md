# Figma Ops iteration 2: проверка и границы

Проверка 23.10.2026. Основание: [binding design](../specs/2026-10-23-figma-ops-iteration-2-design.md), [CLI/workflow README](../../../plugins/figma-ops/README.md). Выпуск: Figma Ops 1.1.0, standalone compatibility Figma Lookup 1.2.0; каждый plugin root содержит свой runtime и пять references. Все команды read-only, публичные fixtures синтетические. Приватные identifiers, тексты и assets в этот отчёт не включены.

## Локальные проверки

Packaging RED до правок release files: `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_packaging.py' -v` — 5 tests, 6 ожидаемых failing subtests (прежние версии четырёх manifests, отсутствие context reference в двух roots). Standalone runtime был успешен уже в RED; runtime дефект этим прогоном не заявляется.

После sync той же командой — 5/5 OK. В двух изолированных roots, каждый без sibling, из cwd с пробелами выполнены по 10 операций и 11 help calls: всего 20 synthetic операций и 22 help calls. Дополнительно по одному malformed annotations case на root: status partial, exit0. Transport синтетический, без сети/Keychain; annotations/interactions raw и полный связанный thread проверены. Equality покрывает 11 runtime modules, пять references и тело skill; sync воспроизводим, stale runtime удаляется. Catalog/manifests и локальные ссылки references проверены для обоих хостов.

Итоговый `python3 -B -m unittest discover -s plugins/figma-ops/tests -v` — 191 tests OK, exit0. `git diff --check` — пусто. AST `feature_version=(3,10)` — 23 canonical/generated runtime/sync files OK на фактическом Python 3.13.7; Python 3.10 runtime не запускался. Установленный `skill-creator/scripts/quick_validate.py` отдельно для обоих skill roots — exit0 / `Skill is valid!`; name/description/body/references дополнительно проверяются packaging tests.

Controller privacy scan известных приватных input values по 207 tracked и неигнорируемым новым files — 0 matching files, значения не выводились. Scan не требует копирования приватных payloads в публичные fixtures.

## Read-only live, выполненный controller

| Источник | Фактический результат | Что не доказано |
|---|---|---|
| Annotations | exit0/ok; 94 nodes, поле отсутствовало на 94/94, 0 annotations, missing-field warning, complete=false | Положительное чтение содержимого реальной annotation не выполнено; новую заметку ради теста не создавали |
| Prototype | exit0/ok; 1855 nodes, 4 interactions/4 actions, 0 edges, 6 timings, 4 legacy records, 0 frontier, 1 requested/1 successful root; limit1/output сохранил все собранные records | Все четыре фактических NODE destinations были null; live follow по ненулевому destination не проверен |
| Context | exit0/ok; 2575 nodes, source/root точные, ancestry/page присутствуют; structure/annotations/prototype/comments collected; 1 thread с 2 replies; limit1/output сохранил полный dossier | Полнота всего файла/входящего графа не заявляется; annotations content не подтверждён |
| Host motion | Официальный recursive get_motion_context успешно вернул 24 animated nodes и snippets языков css/motionDev; отдельный evidence artifact | Отдельное raw tracks field не наблюдалось; REST transitions не выдаются за keyframe tracks |

У prototype все verified_unit/normalized_ms остались null, unit_basis=unverified; raw числа сохранены, complete=false. Это не калибровка единиц и не доказательство длительности UI. У context metadata сохранены: начальные source sections имеют согласованные timestamps, comments — независимый timestamp и version=null, snapshot_consistency=independent-requests. Motion/canvas_visual в CLI not_collected, общий complete=false, два warnings; это не недоступность MCP и не отсутствие motion в макете. Приватные raw ответы остались в локальных игнорируемых artifacts, не в git. Whole-page timeout не повторялся, дизайн не менялся, credentials не настраивались.

## Свежая routing simulation

OLD snapshot/evaluation снят controller до изменения skill. NEW оценён свежим native agent по замороженным skill/references на тех же шести отложенных задачах. Оба сохранили все шесть safety boundaries:

| Сценарий | Наблюдение OLD/NEW |
|---|---|
| Annotations и comments | Оба различили заметку ноды и полный thread; NEW дал прямой маршрут annotations |
| Source и экранный root | Оба выбрали правильный экран для MCP с prerequisite; NEW дополнительно сохранил исходный source в REST dossier через отдельный scope-root и отверг sibling |
| Prototype и timeline | Оба разделили transitions и keyframe motion, включая отдельное чтение destination по задаче |
| Непроверенные единицы | Оба сохранили raw REST и отдельно явное требование пользователя к длительности; OLD уже был корректен |
| Partial и budgets | Оба сохранили полный собранный artifact, ошибки/frontier и предел GET попыток |
| Missing tools и неполный dossier | Оба продолжили доступное, сохранив непроверенные секции без утверждения отсутствия данных |

NEW также описал прямые context/prototype маршруты; OLD иногда сначала требовалась help для новых команд. Различия описывают выразимость нового workflow. Здесь нет routing RED или доказанного количественного улучшения: OLD уже сохранял все проверенные safeguards. Это симуляция выбора действий без выполнения CLI/MCP/credentials, а не live discovery/activation Claude Code/Codex. IDs, значения и цитаты отложенных задач в продуктовые примеры и этот отчёт не копировались.

Исторический запуск Claude CLI для live host verification был отклонён автоматической проверкой разрешений: передача локального plugin во внешний inference без авторизации. Повтор/обход не выполнялся. Native simulation и isolated packaging подтверждают только собственные области, а не работу реального host discovery.

## Принятые решения и их стоимость

1. Task 4 следует подробным Interfaces/Step 5: `collect_prototype` получает уже загруженный scope и follow0, используется общий frontier без дополнительного GET. Это сохраняет один nodes GET в context. Если выбранное переиспользование окажется неверным, стоимость исправления ограничена выделением чистого frontier helper; shipping runtime redesign в Task 5 не выполнялся.
2. Standalone generated compatibility copies сохранены, sync/equality tests контролируют совпадение canonical/legacy. Цена — размер дистрибутива и сопровождение sync. Runtime не зависит от установленного sibling plugin.

## Ограничения приёмки

Положительные annotation content, ненулевые live prototype destinations и реальное activation/discovery обоих host clients остаются непроверенными. Успех текущего motion tool не обещает raw tracks в каждом ответе. Фактический Python 3.10 runtime не запускался; AST feature_version=(3,10) проверяет только синтаксис. Task reviews и итоговое whole-branch review по исходной spec выполняются controller отдельно и не заменяются simulation. Ветка/worktree сохраняются; push, PR, merge и установка не выполнялись.
