# Figma Ops Iteration 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить чтение Dev Mode annotations и прототипных взаимодействий, ограниченный обход переходов и единый REST-контекст точного subtree с отдельными последующими шагами MCP для motion.

**Architecture:** Существующие auth/cache/envelope и standalone CLI сохраняются. Общий loaded scope передаётся чистым extractors annotations/interactions и сборщику context; prototype добавляет BFS поверх того же extractor. Skill организует последующее чтение MCP, CLI не управляет хостом.

**Tech Stack:** Python 3.10+ standard library, системный curl, argparse/dataclasses/unittest; без pip/npm и нового MCP-сервера.

**Spec:** `docs/superpowers/specs/2026-10-23-figma-ops-iteration-2-design.md` (проверенный дизайн `68d8e62`).

## Global Constraints

- Все команды читают данные. Не входят отправка/resolve комментариев, изменение реакций или макетов, Code Connect mappings, разрешение всего графа variables/styles, visual diff, подписка на изменения, общий MCP-сервер и автоматическая реализация фронтенда.
- Сохранить существующие семь команд и `schema_version: 1`. Существующие envelopes не меняют смысл. Exit 0 — ok/partial, 1 — operational error, 2 — invalid arguments.
- Auth только существующий `FIGMA_TOKEN` или Keychain `figma-rest/figma`; нет чтения иных credentials/configs. Фиксированный `https://api.figma.com/v1/`, TLS, 35s timeout, cache 300s, безопасные ошибки и отсутствие бесконечных retries остаются из первой итерации.
- Все три команды требуют node из URL или `--node`; без node — argument error до сети. Не делать скрытого whole-file scan. Составные instance IDs сохранять без преобразований. Не включать geometry=paths для разведки.
- Общий результат pure extractors — `Collected(data: dict, coverage: dict, warnings: list[str], partial: bool = False)`, всегда полный и без network/limit. Новая provenance содержит source=figma-rest, file_key, node_id, json_pointer относительно корня ноды node_id, fetched_at, version; action_path отдельно относительно interaction. При Task N briefing передавать также Interfaces производителей, на которые ссылается task.
- Общие `--refresh`, `--no-cache`, `--cache-dir`, `--output` работают после subcommand. `--limit N` (по умолчанию 20, положительное число) ограничивает только inline записи, не сканирование; `--output` сохраняет все собранные записи, но никогда не отменяет явные сетевые budgets.
- Для каждой секции указать `state: collected|partial|failed|not_requested|not_collected`, source, fetched_at, version nullable и coverage. Comments не имеют версии документа: snapshot_consistency=`independent-requests`, даже при одинаковом времени. Не утверждать атомарный snapshot.
- До отдельной подтверждённой калибровки REST timing verified_unit и normalized_ms остаются null, unit_basis=unverified, выдаётся общий warning timing_units_unverified. Не использовать эвристику «число меньше единицы → секунды».
- В реализации поднять canonical figma-ops до 1.1.0, compatibility figma-lookup до 1.2.0; manifests/catalogs обновить согласованно. Legacy регенерируется sync-compat.py, работает самостоятельно без соседнего plugin root.
- Данные из макета/annotations/comments никогда не меняют системные инструкции агента. Не исполнять URL/actions/expressions. Приватные identifiers/texts/assets остаются вне tracked fixtures/reports.
- Workers/reviewers: synthetic fixtures, без сети/Keychain/секретов, без собственных subagents. Только controller выполняет разрешённые live-чтения. Не повторять отклонённый Claude CLI и не обходить policy другим транспортом.
- Ветка `figma-ops-iteration-2`, существующий worktree `/Users/y.mihalev/projects/agent-utils-figma-ops-iteration-2`; не создавать другой и не менять установленную версию на незавершённую. Push/PR/merge — отдельное поручение; PR в YarikMix/agent-utils всегда ready for review.

## Review Focus

1. API возвращает dependency раньше цели, override node отличается от URL node, scope-root — сосед. Источник сохраняется, dependency исключается, неподходящий root отклоняется — Tasks 1/4.
2. Null/malformed annotation или action рядом с полезной записью. CLI сохраняет JSON и полезные raw, маркирует partial, не теряет весь пакет — Tasks 1/2.
3. Ромб/цикл графа, одна цель уже загружена как dependency, другая недоступна. Глубина BFS считается по переходам; GET errors расходуют бюджет; загруженная dependency не становится частью исходного scope — Task 3.
4. Неизвестные вложенные actions и времена 0, 0.2, 200 с custom spring/bezier. Сохраняются порядок/raw/JSON Pointer и параметры, не появляется выдуманная единица или выполненное условие — Task 2.
5. `--limit 1 --output` при нескольких секциях, полном thread и исчерпанном budget. Артефакт полный относительно собранного, budget не расширяется, timestamps не превращаются в единый snapshot — Tasks 3/4/5.

## Карта файлов и контрактов

Все новые modules — в `plugins/figma-ops/scripts/`, tests — в `plugins/figma-ops/tests/`.

| Файл | Ответственность / владелец |
|---|---|
| `figma_ops_scope.py` (новый) | LoadedScope/Collected, точный source/root/ancestry и identity; Task 1 |
| `figma_ops_annotations.py` (новый) | Annotation extraction/query/CLI handler; Task 1 |
| `figma_ops_interactions.py` (новый) | Чистое извлечение action tree, edges, timings, legacy; Task 2 |
| `figma_ops_prototype.py` (новый) | Prototype handler, затем BFS и budgets; Tasks 2 → 3 |
| `figma_ops_context.py` (новый) | REST dossier, секции, проекции, host next_actions; Task 4 |
| `figma_ops_comments.py` (существующий) | Выделение reusable pure thread selection без изменения старого поведения; Task 4 |
| `figma_ops.py` (существующий) | Регистрация новых команд и флагов; Tasks 1 → 2 → 3 → 4 |
| `context_fixtures.py` (новый test helper) | Fresh synthetic file/comments payloads и настоящий main через CurlBoundary; Task 1 |
| `test_annotations.py`, `test_interactions.py`, `test_prototype.py`, `test_context.py` (новые) | Проверки соответствующей ответственности, с реальным JSON/output; Tasks 1–4 |
| `test_comments.py`, `test_cli.py`, `test_packaging.py` | Регрессии прежних команд и standalone доставки; Tasks 1–5 по затронутому пути |
| canonical `SKILL.md`, `references/context.md` (новый), `references/reading.md`, README обоих имён, корневой README, 4 plugin manifests, 2 marketplace catalogs | Workflow, release и доставка; Task 5 |
| `plugins/figma-lookup/scripts/*.py`, `skills/figma-lookup/SKILL.md`, `references/*.md` | Только generated artifacts после canonical изменений каждой задачи |

`sync-compat.py` уже копирует все runtime `*.py`, кроме себя, и все references; менять его только если новая структура действительно этого требует. Известные жёсткие ожидания тестов: `test_packaging.py` содержит COMMANDS, версии и точное множество четырёх references — обновлять их там, где функциональность добавляется.

Общий выход pure extractors: `Collected(data: dict, coverage: dict, warnings: list[str], partial: bool = False)`. Он содержит полный собранный результат, без limit и сетевых вызовов. Handlers строят обычный envelope, context — section wrappers. Не менять raw/cache objects при проекции.

В новых `provenance`: `source='figma-rest'`, `file_key`, `node_id`, `json_pointer` (от корня ноды node_id, не всего API response), `fetched_at`, `version`. У каждой interaction есть index; action_path/condition_path внутри неё следуют JSON Pointer из спеки. Внешний pointer и путь action не смешивать.

`--limit` применяет slice к каждому верхнеуровневому списку data; coverage.collections для каждого хранит total/returned/truncated. В raw выбранного interaction action tree не обрезать. Context аналогично ограничивает texts/annotations/interactions/threads и производные prototype lists; ancestry/identity не ограничиваются, thread replies не обрезаются. `limit=None` означает полный результат для `--output`. Ни один limit не управляет обходом сети.

## Выполнение и проверка

Последовательность зависимостей: **1 → 2 → 3 → 4 → 5**. Один implementer за раз, task-scoped review каждой задачи; финальный reviewer получает исходную спецификацию и полный branch diff. Task 4 использует pure extractor Task 2, не вызывает prototype CLI и не включает follow. Частые path-scoped commits допускаются в этом отдельном worktree, без чужих файлов.

На старте исполнения сохранить BASE и убедиться, что дерево чистое; baseline: `python3 -B -m unittest discover -s plugins/figma-ops/tests -v` — текущие 116 tests должны пройти. Результат фиксируется, не подменяет RED новых regression tests. Report каждой задачи содержит точные RED/GREEN команды и output; build/check steps не считаются реализацией, пока не выполнены.

### Task 1: Loaded scope и annotations CLI

**Files:** Create `plugins/figma-ops/scripts/figma_ops_scope.py`, `plugins/figma-ops/scripts/figma_ops_annotations.py`, `plugins/figma-ops/tests/context_fixtures.py`, `plugins/figma-ops/tests/test_annotations.py`; Modify `plugins/figma-ops/scripts/figma_ops.py`, `plugins/figma-ops/tests/test_packaging.py`; regenerate `plugins/figma-lookup/scripts/*.py`.

**Interfaces:**
- Consumes existing `Target`, `ApiResponse`, `Client.get_json`, `OpsError`, `parse_target`, `envelope`; `walk_nodes`, `find_node`, `require_document` из nodes module.
- Produces dataclasses `LoadedScope(target: Target, response: ApiResponse, source: dict, source_ancestors: list[dict], root: dict, root_ancestors: list[dict])` и `Collected(data: dict, coverage: dict, warnings: list[str], partial: bool = False)`.
- Produces `load_scope(client: Client, target: Target, *, root_id: str | None = None) -> LoadedScope`: node обязателен; один GET files/key?ids=SOURCE[,ROOT], без глобального depth; exact lookup обоих, проверка ancestry root/source, `scope_mismatch` при неверном отношении. Нормализовать root_id тем же parse_target; равные ids в query не дублировать.
- Produces `node_identity(node: dict, ancestors: list[dict], file_key: str) -> dict`: id/name/type/path/page/url, где path — список имён, page — id/name/type или null.
- Produces `extract_annotations(scope: LoadedScope, query: str | None = None) -> Collected`; `annotations(args, client: Client) -> dict` handler.
- Test helper produces `payload() -> dict`, `comment_payload() -> dict`, `invoke(argv: list[str], responses: list[tuple[int, dict, dict]]) -> tuple[int, dict, CurlBoundary]`. invoke использует настоящий `cli.main`, `Client(token='synthetic-secret', no_cache=True)` и existing `test_core.CurlBoundary`, а не stub handler; stdout разбирается json.loads.

- [ ] **Step 1: Написать RED tests.** Fresh fixture `payload()`: DOCUMENT `0:0`, первая dependency page с FRAME `9:9` и посторонней annotation; затем CANVAS `1:0` с FRAME `2:0`, INSTANCE `2:1`, TEXT `I2:1;3:1` внутри него и sibling TEXT `2:2` в frame. Version `v1`. В `2:1` annotation label=`Straße note`, properties=`[{'type':'width'}]`; у TEXT — labelMarkdown=`STRASSE markdown` и categoryId, у sibling — только pinned properties. Все fixture calls возвращают новые dict. Добавить assertions:

```python
# test_annotations_casefolds_full_scope_before_inline_limit
code, result, transport = invoke(['annotations', 'Key', '--node', '2-1', '--query', 'STRASSE', '--limit', '1'], [(200, payload(), {})])
assert code == 0
assert result['coverage']['scanned_nodes'] == 2
assert result['coverage']['total_annotations'] == 2
assert result['coverage']['matched_annotations'] == 2
assert result['coverage']['returned'] == 1
assert result['data']['annotations'][0]['node']['id'] == '2:1'
assert result['data']['annotations'][0]['raw']['properties'] == [{'type': 'width'}]
assert result['coverage']['complete'] is False
```

В отдельных именованных tests проверить output с limit1 сохраняет обе записи и categoryId/markdown; отсутствие query сохраняет properties-only sibling; missing field → ok + missing count/warning, [] → explicit count, null/не-dict item рядом с корректной annotation → partial с полезной записью и raw/identity. Для malformed item сохранить его как raw, nullable label/properties и warning, а query не считать совпавшим, если нет валидного текста. Проверить parse branch/composite IDs, no-node/empty query/limit0 до transport, source не найден → error. Scope tests: root2:0/source2:1 успешен одним GET; root2:2 даёт scope_mismatch; дерево глубиной 1200 обходится без рекурсии. Не менять fixture/cache при extraction/projection.

- [ ] **Step 2: Запустить RED.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_annotations.py' -v` — FAIL из-за отсутствующих новых modules/command или неверных assertions; сохранить вывод.
- [ ] **Step 3: Реализовать scope types/loader/identity по Interfaces.** Переиспользовать существующий iterative walker и node lookup; не переписывать transport, parser или старый inspect.
- [ ] **Step 4: Реализовать extractor/handler и зарегистрировать annotations.** Порядок DFS + annotation_index, raw полностью, Unicode literal query, поля/coverage по спеке. SOURCE/root только exact loaded subtree. Common flags после subcommand, limit20, query optional nonempty. Status partial только для malformed/unsupported данных; отсутствие поля само по себе не partial.
- [ ] **Step 5: GREEN и доставка.** Добавить annotations в COMMANDS и synthetic packaging operation; его fixture должен содержать annotation. Выполнить `python3 plugins/figma-ops/scripts/sync-compat.py`, затем focused annotations suite и полный `python3 -B -m unittest discover -s plugins/figma-ops/tests -v` — OK, прежние операции проходят. `git diff --check` — пусто.
- [ ] **Step 6: Path-scoped commit и отчёт.** Commit `feat: read scoped Figma annotations`; включить только перечисленные canonical/test/generated paths. Передать reviewer diff и спецификацию, включая missing-field semantics.

### Task 2: Полные interaction/action trees и prototype follow0

**Files:** Create `plugins/figma-ops/scripts/figma_ops_interactions.py`, `plugins/figma-ops/scripts/figma_ops_prototype.py`, `plugins/figma-ops/tests/test_interactions.py`, `plugins/figma-ops/tests/test_prototype.py`; Modify `plugins/figma-ops/scripts/figma_ops.py`, `plugins/figma-ops/tests/context_fixtures.py`, `plugins/figma-ops/tests/test_packaging.py`; regenerate `plugins/figma-lookup/scripts/*.py`.

**Interfaces:**
- Consumes Task 1 `LoadedScope`, `Collected`, `load_scope`, `node_identity`, fixture invoke/payload.
- Produces `extract_interactions(scope: LoadedScope) -> Collected`: data lists `interactions`, `actions`, `edges`, `timings`, `legacy`; coverage scanned_nodes/with-field/without-field/complete=false. Все списки полные, порядок исходный. `interactions` содержит node identity/index/trigger/raw/provenance; `actions` — все actions с action_path/condition_path/raw; `edges` — только NODE с ненулевым string destinationId. Условный edge сохраняет condition_path, не evaluated truth.
- Produces `project_prototype(result: Collected, limit: int | None) -> Collected`, общий механизм inline copies с per-list collection counters; raw action tree остаётся полным.
- Produces `prototype(args, client: Client) -> dict`, CLI `prototype TARGET [--node ID] [--limit N]`. В этом task только исходный subtree; follow flags вводятся Task 3. Pure extractor не строит frontier и не делает сеть.

- [ ] **Step 1: Написать RED tests extractor и CLI.** Synthetic interaction на `2:1`: trigger ON_CLICK; actions `[NODE→3:0, CONDITIONAL(block0 condition + actions [SET_VARIABLE, NODE→4:0]), BACK, NODE(destinationId=None)]`. Оба NODE имеют transition SMART_ANIMATE с duration=0.2 и cubic-bezier; отдельные cases duration0/200, mediaHitTime, custom spring initialVelocity. Assertions включают:

```python
# test_nested_actions_preserve_order_pointers_and_unverified_times
result = extract_interactions(scope)
assert [(e['destination_id'], e['action_path']) for e in result.data['edges']] == [
    ('3:0', '/actions/0'), ('4:0', '/actions/1/conditionalBlocks/0/actions/1')]
assert result.data['edges'][1]['condition_path'] == '/actions/1/conditionalBlocks/0'
timing = next(t for t in result.data['timings'] if t['raw_field'].endswith('/transition/duration'))
assert timing['raw_value'] == 0.2
assert (timing['documented_unit'], timing['verified_unit'], timing['normalized_ms'], timing['unit_basis']) == ('ms', None, None, 'unverified')
assert result.data['interactions'][0]['raw'] == original_interaction
```

Добавить tests нескольких interactions, глубоких nested actions (1200 уровней на pure extraction; CLI JSON-depth не расширять), escaping `~`/`/` в paths, trigger timeout/delay documented ms, mediaHitTime documented s, timing raw без округления; unknown enum/raw с warning/partial; malformed action рядом с валидным NODE сохраняет raw и полезный edge; null destination не создаёт edge. Missing interactions → ok/missing, [] → explicit-empty, null → partial. Legacy-only → legacy evidence без trigger; modern присутствует даже [] → основной источник, противоречивый legacy сохраняется с warning без duplicate edge. Проекция не мутирует payload. В CLI --output limit1 сохраняет все interactions/actions/edges/timings.

- [ ] **Step 2: RED.** Поочерёдно `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_interactions.py' -v` и аналогично `test_prototype.py` — FAIL на отсутствующей функциональности; сохранить output.
- [ ] **Step 3: Реализовать iterative extraction по Interfaces.** Для conditional хранить явный stack с index/path/condition; не исполнять expressions/actions и не сортировать их. Nullable/неизвестные поля не подменять default durations/easing. Недокументированное численное поле времени сохраняется raw с documented_unit=null; не выдавать его за duration.
- [ ] **Step 4: Реализовать handler/projector и зарегистрировать prototype.** Один load_scope и extractor; apply limit только после полного извлечения, общий envelope source/version/cache. В follow0 handler добавить frontier всех NODE destinations вне исходного subtree с reason depth_limit (внутренние IDs уже прочитаны); frontier → partial, timing warning сам по себе → ok. Не считать dependency частью scope, даже если она попала в ответ API.
- [ ] **Step 5: GREEN и доставка.** COMMANDS/standalone operation дополнить prototype, synthetic fixture без внешних destinations для ожидаемого ok. Sync legacy, focused interaction/prototype suites и полный suite — OK; diff check — пусто.
- [ ] **Step 6: Commit/отчёт.** `feat: expose Figma prototype actions and raw timing evidence`; reviewer проверяет исходную spec, действия с несколькими branches и неизвестными payloads, не только таблицу edges.

### Task 3: Bounded BFS по prototype destinations

**Files:** Modify `plugins/figma-ops/scripts/figma_ops_prototype.py`, `plugins/figma-ops/scripts/figma_ops.py`, `plugins/figma-ops/tests/test_prototype.py`, `plugins/figma-ops/tests/context_fixtures.py`; regenerate `plugins/figma-lookup/scripts/*.py`.

**Interfaces:**
- Consumes Task 2 extractor/projector и Task 1 scope loader/types.
- Produces `collect_prototype(scope: LoadedScope, client: Client, *, follow: int = 0, max_frames: int = 20) -> Collected`: включает все data lists extractor, `frontier` и `observations`. `observations`: requested_root_id, depth, fetched_at/version/cache nullable, safe error nullable, result state. Initial response — первая observation; envelope metadata остаётся initial response.
- Handler получает `--follow` int0..3 (default0), `--max-frames` int1..50 (default20); invalid values — invalid_argument до GET. Coverage `requested_roots`, `successful_roots`, `failed_roots` — int; `expanded_from_loaded_nodes` — int уникальных roots без GET; также `follow`, `max_frames`, versions observations, visited IDs и collection totals.

- [ ] **Step 1: Написать RED graph tests.** Граф root A=`2:1` → B=`3:0`, C=`4:0`; B и C → D=`5:0`; D→A. Каждый destination — отдельный root без локальных дочерних рёбер между roots. Fake transport responses проверяют params.ids и точную последовательность GET; внешний loaded dependency включается в initial document перед source, но в действиях source присутствует только отдельная подтверждённая ссылка на неё. Assertions:

```python
# test_bfs_diamond_and_cycle_read_each_root_once
# follow2: загрузить A,B,C,D ровно по одному разу; цикл не расширять повторно.
assert requested_ids == ['2:1', '3:0', '4:0', '5:0']
assert result['coverage']['requested_roots'] == 4
assert result['coverage']['successful_roots'] == 4
assert result['coverage']['failed_roots'] == 0
assert result['data']['frontier'] == []
```

Именованные tests: follow0 читает только A, frontier B/C depth_limit; follow1 читает A/B/C, D остаётся frontier depth_limit; max_frames1 не делает GET кроме A; max_frames2 с B403 не читает C и даёт counts2/1/1, C frame_limit; оба missing destinations расходуют слоты, не позволяют неограниченный перебор. Полученная dependency может быть использована только после подтверждённого edge, без дополнительного GET и без счёта её несвязанных соседей. Другой version у B виден в observations и warning. B404/timeout даёт partial с полезным A/C; B429 прекращает дополнительные GET, оставшиеся roots rate_limited, retry_after сохранён. Дубликаты/cycles не дают новых GET. --output с limit1 сохраняет все уже собранные lists/frontier, но число GET и frontier reasons совпадают с inline режимом. Проверить follow -1/4 и max0/51 до transport.

- [ ] **Step 2: RED.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_prototype.py' -v` — FAIL на новых graph assertions, сохранить output.
- [ ] **Step 3: Реализовать collect_prototype и перевести handler на него.** BFS queue (root id, graph depth), known loaded nodes index, набор requested/expanded roots. Слот requested_roots резервировать до GET, включая cache hit и неуспех, initial A расходует слот1. Один узкий GET на новый root, never page/full-file. На границе depth всё ещё извлекать actions загруженного root; непокрытые цели остаются frontier. Загруженная dependency доступна для expansion только при подтверждённом NODE edge; включить её в collected scope только на разрешённом follow depth. Циклы, уже достигнутые roots и находящиеся внутри уже расширенного subtree IDs не создают frontier. Дедуплицировать прочитанные nodes/interaction rows, не теряя provenance первого наблюдения и отдельную observation нового response.
- [ ] **Step 4: Проверить failure aggregation.** Initial GET ошибки остаются error; destination errors безопасно представлены per-root. Frontier item содержит source_node_id/interaction_index/action_path/destination_id/depth/reason/error nullable. Любой непустой frontier или extractor.partial → partial; только warnings units/missing/version не меняют acquisition status. Не выполнять sleep/retries; 429 приостанавливает только сеть, не теряет уже собранное. Projector ограничивает frontier inline с отдельными counts, полный output сохраняет все reasons.
- [ ] **Step 5: GREEN и регрессии.** Sync legacy; prototype suite, interaction suite и полный suite — OK. `git diff --check` — пусто.
- [ ] **Step 6: Commit/отчёт.** `feat: bound prototype traversal by depth and attempted roots`; reviewer получает synthetic graph expectations, budget semantics и точный request log из tests.

### Task 4: REST context с source/root и полными обсуждениями

**Files:** Create `plugins/figma-ops/scripts/figma_ops_context.py`, `plugins/figma-ops/tests/test_context.py`; Modify `plugins/figma-ops/scripts/figma_ops_comments.py`, `plugins/figma-ops/scripts/figma_ops.py`, `plugins/figma-ops/tests/test_comments.py`, `plugins/figma-ops/tests/test_cli.py`, `plugins/figma-ops/tests/test_packaging.py`, `plugins/figma-ops/tests/context_fixtures.py`; regenerate `plugins/figma-lookup/scripts/*.py`.

**Interfaces:**
- Consumes scope, annotations extractor и `collect_prototype(scope, client, follow=0, max_frames=20)`/prototype projector; не вызывает handlers/CLI subprocess и не выполняет дополнительных prototype GET при follow0.
- Refactor produces `load_threads(client: Client, target: Target) -> tuple[ApiResponse, list[dict], int]` с нынешним _load_threads поведением; `select_threads(threads: list[dict], *, node_ids: set[str] | None = None, query: str | None = None, author: str | None = None, status: str = 'all') -> Collected`. data.threads полные; coverage total_threads/matched_threads/unassigned_count, partial для orphan, warnings из существующих правил. Старые comments/thread handlers переиспользуют это, сохраняя прежние keys, statuses, timestamps, node_scope и scopes.
- Produces `context(args, client: Client) -> dict`, `context TARGET [--node ID] [--scope-root ID] [--without-comments] [--limit N]`. Source=effective parse_target(target,node); url_node_id отдельно из parse_target(target). Root из scope-root или source. Source/root loader один раз, comments один GET если не skipped.
- data: source_node, scope_root, url_node_id, ancestors, page, suggested_context_roots (ancestor FRAME identities), snapshot_consistency и sections `{structure, annotations, prototype, comments, motion, canvas_visual}`. Section wrapper fields state/source/fetched_at/version/coverage/data/warnings/error; у not_requested/not_collected fetched_at/version/data/error=null. Для comments version=null независимо от тела comments API. Structure содержит type_counts, total_nodes, direct_children identity+bbox, texts identity+characters.
- `motion`/`canvas_visual`: state=not_collected, reason=requires-host-tool, source=figma-mcp; next_actions записаны в верхнем data, kind=`motion_context`/`canvas_visual`, file_key/node_id=scope root, purpose и prerequisites. Это данные, не shell/script. Путь для motion — текущая схема get_motion_context; CLI ничего не запускает и не заявляет tool availability.

- [ ] **Step 1: Написать RED tests reusable comments selection.** Использовать прежние root/reply/orphan fixtures: query только в reply возвращает полную ветку; scope по root pin, не reply pin; без node_ids остаётся file scope; unassigned считается отдельно. Snapshot прежних public coverage/keys через существующие assertions, не через бессмысленную копию implementation. `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_comments.py' -v` — новые imports/assertions должны упасть до refactor.
- [ ] **Step 2: Выделить load_threads/select_threads и проверить GREEN comments suite.** Transport/node lookup остаются в старом handler, pure selector принимает уже известный ids set. Никаких дополнительных GET /me или content для thread без node scope. Sync нужен до полного packaging прогона, не для pure comments suite.
- [ ] **Step 3: Написать RED context tests.** comment_payload содержит root pin=2:1, два ответа (совпадение запроса только во втором), соседний root pin=9:9, unassigned root. Для context без query возвращается вся относящаяся ветка; reply-only проверяется отдельно selector test из Step1. С URL node2:1 и scope-root2:0 проверить:

```python
# test_context_preserves_source_root_and_full_thread_with_two_gets
assert data['source_node']['id'] == '2:1'
assert data['scope_root']['id'] == '2:0'
assert [n['id'] for n in data['ancestors']] == ['0:0', '1:0', '2:0']
assert data['sections']['comments']['data']['threads'][0]['root']['id'] == 'thread-root'
assert len(data['sections']['comments']['data']['threads'][0]['replies']) == 2
assert requested_paths == ['/v1/files/Key', '/v1/files/Key/comments']
assert requested_query == {'ids': ['2:1,2:0']}
assert data['snapshot_consistency'] == 'independent-requests'
assert data['sections']['comments']['version'] is None
assert data['sections']['motion']['state'] == 'not_collected'
assert result['coverage']['complete'] is False
```

Отдельные cases: URLnode2:2 overridden --node2:1 сохраняет url_node_id2:2 без выдачи его за исследованное; root=sibling error scope_mismatch, source/root missing error; without-comments делает ровно один GET и state not_requested; comments403/invalid_response → partial и failed только comments, структура остаётся; missing fields даёт collected с missing counters, malformed annotations → partial. При разных mocked fetched_at у source/comments сохраняются оба значения; comments никогда не получает document version. Для annotations/prototype/structure response metadata совпадает с initial source response.

Проверить limit1 для texts/annotations/interactions/threads отдельно: totals полные, returned1/truncatedtrue только у соответствующих lists, replies2 сохранены; --output хранит всё, stdout — существующая artifact summary. У direct_children тоже отдельные counts/limit (это новый выбор проекции); ancestry/source/root не обрезать. Объект bbox передавать как наблюдение, не использовать для вычисления pinned property width. Next actions остаются host hints, нет вызовов MCP/subprocess кроме существующего transport. No-node/scope-root без source/limit0 — argument error до GET.

- [ ] **Step 4: RED context.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_context.py' -v` — FAIL на отсутствующем command/section contract; сохранить output.
- [ ] **Step 5: Реализовать context и CLI flags.** Один load_scope; собрать ids/structure, получить annotations и collect_prototype с уже загруженным scope/follow0, затем independent comments request и pure selector. Коллектор использует initial response и не делает дополнительных prototype GET; partial секции агрегировать. Failed comments безопасно ловить как OpsError на этой секции, без blanket Exception. Host sections и comments skipped не делают partial; raw timing warning также не делает partial. Ни API JSON, ни raw/cache objects не мутировать. Все collection limits применить после полного локального сбора.
- [ ] **Step 6: GREEN и доставка.** Дополнить COMMANDS/standalone fixture context case с привязанным root pin; проверить все десять команд. Sync; context/comments/CLI suites и полный suite — OK, diff check — пусто.
- [ ] **Step 7: Commit/отчёт.** `feat: assemble scoped Figma context with complete discussions`; task review проверяет call count, source/root и сохранность прежних comments/thread контрактов по спецификации.

### Task 5: Workflow, версии, standalone packaging и приёмка

**Files:**
- Modify: `plugins/figma-ops/skills/figma-ops/SKILL.md`, `plugins/figma-ops/skills/figma-ops/references/reading.md`, `plugins/figma-ops/README.md`, `plugins/figma-lookup/README.md`, `README.md`, `plugins/figma-ops/tests/test_packaging.py`.
- Modify: `plugins/figma-ops/.claude-plugin/plugin.json`, `plugins/figma-ops/.codex-plugin/plugin.json`, `plugins/figma-lookup/.claude-plugin/plugin.json`, `plugins/figma-lookup/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`.
- Create: `plugins/figma-ops/skills/figma-ops/references/context.md`, `docs/superpowers/research/2026-10-23-figma-ops-iteration-2-verification.md`.
- Generated: `plugins/figma-lookup/scripts/*.py`, `plugins/figma-lookup/skills/figma-lookup/SKILL.md`, `plugins/figma-lookup/skills/figma-lookup/references/*.md`.

**Interfaces:**
- Consumes десять CLI команд и sections/coverage из Tasks1–4; generator без runtime-зависимости legacy от sibling.
- Produces figma-ops1.1.0/figma-lookup1.2.0 во всех четырёх manifests и обоих catalog entries; одинаковое тело canonical/legacy skill и пять references (auth/reading/comments/assets/context).
- Produces описание единого workflow: context → явный root/screenshot при необходимости → annotations/prototype → отдельный get_motion_context по source/destination в зависимости от задачи, evidence artifacts рядом. Tool discovery и official skill prerequisites остаются обязательными.

- [ ] **Step 1: До изменения skill снять OLD на отложенных сценариях.** Controller сохраняет canonical skill+references snapshot и шесть synthetic задач в локальной непубликуемой папке, получает выбор действий fresh native agents без tools/credentials. Сценарии: отличить annotations от comments; не потерять source при root frame; отличить prototype duration от keyframes; не преобразовать 0.2 в ms по догадке; сохранить partial/frontier при403/budget; продолжить доступное при missing MCP/token. IDs/цифры контрольных задач не использовать в новых примерах. Worker не запускает subagents/child CLI; отчёты OLD ему передаёт controller. OLD может успешно решить всё — это фиксируется без выдуманного RED. Это не реальная проверка host activation.
- [ ] **Step 2: Написать packaging RED.** Assert versions canonical1.1.0/legacy1.2.0 в обоих manifests/catalogs; reference set содержит context.md; оба isolated plugin roots запускают все10 operations и11help calls каждый, из cwd с пробелами, без sibling/network/Keychain. Synthetic payloads включают annotations/interactions и связанный thread, отдельный case partial допустим и проверяет code0/statuspartial. Проверить equality новых modules/пяти refs/skill body и повторяемость sync. `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_packaging.py' -v` — FAIL на versions/reference contract.

```python
# test_host_catalogs_resolve_both_plugins_and_discover_skills (обновлённый)
assert (manifest['name'], manifest['version']) == (name, expected_version)
assert entry['version'] == expected_version
# expected_version: figma-ops=1.1.0; figma-lookup=1.2.0, оба хоста.
# test_all_skill_reference_links_resolve_inside_plugin (обновлённый)
assert {p.name for p in references} == {'auth.md', 'reading.md', 'comments.md', 'assets.md', 'context.md'}
# test_standalone_cli_from_cwd_with_spaces (обновлённый), каждый plugin:
assert operation_count == 10
assert help_count == 11
assert json.loads(partial_stdout)['status'] == 'partial'
assert partial_returncode == 0
```
- [ ] **Step 3: Обновить skill/references/READMEs/metadata.** В main skill компактные маршруты и ссылка на context reference; детали annotations, BFS budgets, unknown units, missing-vs-empty, node/scope-root и examples — в focused references. Сохранить полезные сведения старых geometry/QR/assets references. Объяснить: CLI не собирает motion/визуал, does-not-collect не равно API-unavailable; неполный dossier не основание утверждать отсутствие кейса. Перед каждым use_figma — figma-use; motion через него также figma-use-motion; get_design_context только после figma-design-to-code и для реализации. Доступные MCP схемы сверяются при запуске. Не добавлять условные примеры в отложенный набор и не копировать их в skill.
- [ ] **Step 4: GREEN packaging и fresh NEW.** Sync; packaging suite — OK (20 synthetic operations/22help runs между двумя roots, плюс retained checks); controller повторяет те же6 задач с NEW snapshots в fresh native agents, оценивает ожидаемые действия, фиксирует OLD/NEW и пределы. Не называть это доказанным улучшением при одинаковом результате или живым discovery Claude/Codex. Не повторять запрещённый Claude CLI ради GREEN.
- [ ] **Step 5: Итоговая локальная проверка.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -v` — все tests OK; `git diff --check` — пусто. Python AST feature_version=(3,10) для всех canonical/generated runtime и sync, фактический интерпретатор отдельно указать. Frontmatter: `python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" plugins/figma-ops/skills/figma-ops` и отдельно та же команда с `plugins/figma-lookup/skills/figma-lookup` — exit0/Skill is valid. Если скрипт или его уже установленный yaml недоступны, не устанавливать зависимости: packaging assertions проверяют name/description/body/references, а full YAML validation явно остаётся непроверенной. Ссылки references проверяет test_all_skill_reference_links_resolve_inside_plugin. Просканировать публикуемые paths по известным приватным identifiers без вывода их значений. Не повторять suite без новых изменений/падений после успешного прогона.
- [ ] **Step 6: Controller live read-only и sanitized report.** На уже разрешённом файле новый prototype должен вернуть настоящие interactions/actions/raw timings; context — точные source/ancestry, полный thread и section metadata. Взять узкий известный root, не повторять whole-page timeout; использовать только существующий разрешённый token, не выводить его. Для annotations positive check — известная реальная нода; если её нет, явно оставить positive check непроверенным, не создавать annotation ради теста. Host motion проверить при доступном read-only tool и нужде задачи, сохранить фактический результат/unsupported; не выдавать REST transitions за tracks. Приватные ответы только в локальной игнорируемой/scratch папке, опубликованный report — counts/технические результаты/границы и ссылки на spec/README. Не записывать неожиданные локальные артефакты в git.
- [ ] **Step 7: Commit/отчёт и branch review.** `feat: publish context workflow for both Figma plugin names`; path-scoped commit, controller может отдельным docs commit завершить sanitized report. Каждая task review и final whole-branch review сравнивает код с исходной spec, включая ограничения и deliberate choices; final review не заменяется simulation. После принятых fixes и финальных проверок сохранить ветку/worktree, не push/merge/install автоматически. PR при отдельном поручении ready for review.

## Самопроверка плана по спецификации

| Раздел дизайна | Реализация и проверка |
|---|---|
| Intent, anti-goals, read-only и существующие контракты | Global Constraints; retained suites Tasks1–5; final spec review |
| Auth/cache/URL/branch/instance/loaded scope и полнота output | Task1 scope+CLI tests; Task3/4 output tests; без правок transport |
| Annotations/query/pinned/raw/missing-vs-malformed | Task1 |
| Actions/conditional/legacy/easing/raw numbers и единицы | Task2 |
| Follow/BFS/attempt budgets/429/frontier/version observations | Task3 |
| Context source/scope-root, structure, threads, один nodes GET | Task4 |
| Independent snapshot, per-section states/coverage, host hints | Task4 и Task5 OLD/NEW |
| Official prerequisites, внешние данные и separate motion evidence | Task5 workflow/scenarios/live boundaries |
| Versions/copies/standalone/marketplaces | Task5; sync/equality/старые операции в каждом task |
| Live read-only, privacy, positive annotations gap, host limits | Task5 controller acceptance/report |

Interfaces сверены: все новые functions/types объявлены до потребителей; Task4 вызывает коллектор Task3 с follow0 и уже загруженным scope, без новой загрузки nodes. Review Focus1→Tasks1/4, 2→Tasks1/2, 3→Task3, 4→Task2, 5→Tasks3/4/5. План добавляет bounded direct_children projection как builder choice и сохраняет полный artifact; не отменяет требования spec. Изменений продуктового кода на этапе написания плана нет.
