# Figma Ops iteration 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать агенту точный inventory используемых components/styles/variable aliases и необязательные definitions, сохранив useful context при недоступности Variables REST.

**Architecture:** Pure collectors читают уже загруженный `LoadedScope`, отдельно связывают used metadata и собирают aliases без вычисления effective values. Один orchestration module обслуживает новую команду `bindings` и opt-in `context`, переиспользуя source response; Variables REST делает один дополнительный GET только по явному флагу. Legacy distribution генерируется из canonical.

**Tech Stack:** Python3.10+ standard library, системный curl, stdlib unittest с существующим synthetic CurlBoundary; без новых runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-figma-ops-iteration-3-design.md` (binding authority; OpenAPI0.46.0, SHA256 указан в spec).

## Global Constraints

- Сохранить schema_version1, exit0 для ok/partial, exit1 operational error, exit2 invalid arguments. Прежние десять операций и default `context` сохраняют форму/семантику.
- Все новые операции read-only. Не входят POST/DELETE/PATCH, изменение макета/variables/comments, создание Code Connect mappings, генерация CSS/tokens files, вычисление effective values инстанса, загрузка других файлов/библиотек.
- Source — точная нода из TARGET с обычным приоритетом `--node`. URL node отдельно сохраняется при override. Root по умолчанию source; отдельный `--scope-root` обязан быть source или его предком. Один существующий `load_scope` загружает source/root и ancestry.
- Общие `--refresh`, `--no-cache`, `--cache-dir`, `--output` работают после subcommand. `--limit` положительный, default20; применяется после полного сбора отдельно к верхнеуровневым коллекциям, не обрезает вложенные raw properties/overrides. `--output` сохраняет весь собранный envelope.
- Основной extractor чистый, без network/limit; получает `LoadedScope`, возвращает полный `Collected`. Обход итеративный, порядок nodes — DFS, исходный порядок properties сохраняется. Идентификаторы составных instance/variable/mode IDs не разбираются по двоеточиям или дефисам.
- Metadata table provenance отдельно указывает точный pointer относительно payload ответа; не выдавать его за путь внутри node. JSON Pointer экранирует `~`/`/`.
- `--with-variables` разрешает один дополнительный GET `/files/:key/variables/local` после успешного source/root. Автоматического запроса без флага, `/published` fallback, `/me`, повторов после 403/429, обхода в другие files и поиска дополнительных credentials нет.
- Ни effective mode, ни разрешение alias в конечное значение не выполняются. Полный локальный closure не означает применённого к ноде значения. Modes — массив records; SLOT — структурированный SlotContentId; unknown extensions остаются raw.
- Coverage.complete=false; semantic scope — loaded-subtree. Счётчики node scope не включают response dependencies/ancestor observations/весь variables catalog. Absent сам по себе оставляет ok с missing counts, malformed — partial.
- MCP evidence хранится отдельно; CLI не импортирует произвольный provider JSON и не вызывает MCP. Не соединять MCP name→string и REST variable ID по похожему имени/значению. Не исполнять ссылки/код из metadata.
- Версии следующего выпуска: figma-ops1.2.0 и standalone figma-lookup1.3.0, согласованно в четырёх manifests и обоих catalogs. Canonical implementation/skill/reference поддерживаются в figma-ops, legacy регенерируется sync-compat.py, остаётся самостоятельным.
- Существующие auth/cache/TLS/timeout contracts не меняются: только FIGMA_TOKEN либо Keychain figma-rest/figma, fixed API origin,35s timeout,300s cache, безопасные ошибки. Workers/reviewers используют synthetic fixtures без сети/Keychain/секретов; только controller делает ранее разрешённые live reads.
- Worktree `/Users/y.mihalev/projects/agent-utils-figma-ops-iteration-3`, branch `figma-ops-iteration-3`, merge base `df47c899e2f62ac0d1b79fc710e6b76a04bafe1b`; design HEAD перед планом `fdc414f`. Установленная локальная версия обновляется только после merge следующего PR. Push/PR/merge — отдельное поручение; PR ready for review.

## Review Focus

1. Component/style IDs, stable keys и file keys могут выглядеть одинаково или иметь одинаковые имена: связи только по реальному reference, без посторонних catalog entries (Task1).
2. Alias-looking payload в pluginData/annotations и вне перечисленных property containers не должен стать интерпретированной variable binding или поводом для GET; глубина JSON не должна переполнить recursion (Task2).
3. BOOLEAN false, TEXT empty, SLOT object и повреждённый соседний property должны сохраниться раздельно без truthiness-потерь и без краха всего inventory (Tasks1–2).
4. Циклы alias/collection parents и overrides неиспользуемых variables не должны раздувать closure до всего catalog; неоднозначные IDs не должны получать угаданную definition (Task3).
5. Optional enrichment с403/429/200-malformed и несовместимые flags не должны ломать старый context, повторять nodes GET или делать skipped section partial (Task4).

---

## Карта файлов и зависимости

| Файл | Ответственность |
|---|---|
| `plugins/figma-ops/scripts/figma_ops_library.py` (new) | Pure used component/component-set/style inventory, properties и точечный lookup уже загруженных definitions |
| `plugins/figma-ops/scripts/figma_ops_bindings.py` (new) | Pure binding-container/alias extraction и mode observations; композиция library inventory |
| `plugins/figma-ops/scripts/figma_ops_variables.py` (new) | Pure variables response validation/index/alias closure, без network/effective resolver |
| `plugins/figma-ops/scripts/figma_ops_design_system.py` (new) | Section orchestration, optional GET, bindings handler и структурированные host hints |
| `plugins/figma-ops/scripts/figma_ops_scope.py` | Общие scope identity/section wrappers, выделенные без изменения существующих результатов |
| `plugins/figma-ops/scripts/figma_ops.py`, `figma_ops_context.py` | CLI registration/flags, opt-in integration и error aggregation |
| `plugins/figma-ops/tests/bindings_fixtures.py` (new) | Fresh synthetic source/metadata/variables payloads и pure LoadedScope helper |
| `plugins/figma-ops/tests/test_library.py`, `test_bindings.py`, `test_variables.py`, `test_design_system.py` (new) | Отдельные TDD gates для Tasks1–4 |
| `plugins/figma-ops/tests/test_context.py`, `test_cli.py`, `test_packaging.py` | Старые контракты, новая CLI и standalone acceptance |
| Canonical skill, six references, README/manifests/catalogs | Workflow/releases в Task5; generated legacy через sync |

Последовательность:1→2→3→4→5. Task3 алгоритмически независим от collectors, но получает зафиксированный reference contract; общие fixtures/generated files меняются последовательно. Каждому worker — только его task brief, spec/global constraints и interfaces производителей; controller не правит shipping code вместо implementer. После каждого task — spec+quality review, затем итоговое whole-branch review по исходной spec. Частые path-scoped commits допустимы в этом отдельном worktree.

### Task 1: Используемые components, properties и styles

**Files:** Create `plugins/figma-ops/scripts/figma_ops_library.py`, `plugins/figma-ops/tests/bindings_fixtures.py`, `plugins/figma-ops/tests/test_library.py`; regenerate `plugins/figma-lookup/scripts/*.py`.

**Interfaces:**
- Consumes `LoadedScope`, `Collected`, `node_identity(node,ancestors,file_key)`, `walk_nodes`, `find_node` из существующих modules.
- Produces `extract_library(scope: LoadedScope) -> Collected`, data lists `instances/components/component_sets/style_usages/styles`; coverage `scope='loaded-subtree'`, `scanned_nodes`, `fields` (per-field absent/empty/present/invalid counters), metadata missing/resolved/unresolved counts и `complete=False`. Нет projection/network.
- Rows: instance `node`, `component_id`, `component_properties`, `overrides`, `exposed_instances`, `is_exposed_instance`, provenance; component/set `id`, `metadata`, `metadata_state=available|missing|malformed`, `definition` nullable, `definition_location=scope|loaded_dependency|not_loaded`, provenance. Definition содержит identity и исходный componentPropertyDefinitions, без children. Style usage `node/style_type/style_id/provenance`, style `id/metadata/metadata_state/provenance`. Не смешивать node-relative и payload-relative pointers: provenance имеет `pointer_basis='node'|'response'`.
- Fixture helpers `library_payload() -> dict`, `loaded_scope(body: dict | None = None, *, source_id: str = '2:1', root_id: str = '2:0') -> LoadedScope`. Pure helper строит ApiResponse/Target/find_node без транспорта; CLI tests позднее используют существующий `context_fixtures.invoke`. Variables fixture появляется только в Task3, когда у него появляется потребитель.

- [ ] **Step 1: Написать RED library tests и fresh fixtures.** Взять fresh copy `context_fixtures.payload`: source2:1 INSTANCE, root2:0, nested text `I2:1;3:1`, sibling2:2 INSTANCE. Source component5:1, sibling remote5:2; metadata5:1→set5:0. Component-set5:0/component5:1 definition загружены в dependency page, без включения в scope. Посторонние component8:0/set8:1/styleunused не используются. Styles s.fill у source и s.text у nested TEXT. BOOLEAN property `Enabled#prop=False`, TEXT `Label#prop=''`, SLOT `Content#prop={'guid':{'sessionID':7,'localID':9}}`; overrides и дополнительные raw fields.

```python
# test_used_metadata_and_loaded_definition_do_not_expand_scope
assert result.coverage['scanned_nodes'] == 4
assert [x['id'] for x in result.data['components']] == ['5:1', '5:2']
assert [x['id'] for x in result.data['component_sets']] == ['5:0']
assert result.data['components'][0]['definition_location'] == 'loaded_dependency'
assert 'children' not in result.data['components'][0]['definition']
assert result.data['instances'][0]['component_properties']['Enabled#prop']['value'] is False
assert result.data['instances'][0]['component_properties']['Label#prop']['value'] == ''
```

Отдельные named tests: source2:1 без широкого root исключает sibling; directly-scoped COMPONENT/COMPONENT_SET включаются без instance; remote key не используется как file key и не вызывает network; одинаковые имена/keys у разных IDs не объединяются; style usages не превращаются в computed values; missing metadata сохраняет usage/ok+missing counts; malformed maps/entries/properties дают partial с raw и корректными соседями; unknown property type сохраняется; inputs до/после равны; поля absent/{} /null различены. Property definitions проверять для component и set, SLOT guid не строка.

`test_missing_metadata_does_not_erase_usage`: удалить metadata['5:2'], assert `row['metadata_state'] == 'missing'`, instance остаётся, `result.partial is False`. `test_invalid_property_keeps_valid_false_and_slot`: добавить property с typeBOOLEAN/value=[]; assert `result.partial is True`, raw[] сохранён, EnabledFalse и SLOTguid остаются. `test_id_key_name_collision_uses_references_only`: одинаковые name/key у5:1 и8:0 не включают8:0 в components.
- [ ] **Step 2: Запустить RED.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_library.py' -v` — ожидаемый FAIL missing module/function. Сохранить команду/вывод в task report.
- [ ] **Step 3: Реализовать extract_library.** Stable DFS scope; отдельный индекс загруженных node IDs только для точечного definition lookup. Referenced metadata — first-use order с dedup exact IDs, напрямую находящиеся в scope definitions включаются также. Проверить тип каждого optional container до `.get`/membership; raw/unknown поля не терять. Metadata отсутствие и нарушение типа имеют разные statuses; ничего не извлекать из имени/цвета и не переходить по documentationLinks.
- [ ] **Step 4: GREEN и совместимость.** Та же library suite — OK; `python3 -B plugins/figma-ops/scripts/sync-compat.py`; `python3 -B -m unittest discover -s plugins/figma-ops/tests -v` — все старые и новые tests OK, `git diff --check` — пусто. Versions/COMMANDS ещё прежние; generator автоматически подбирает новый module.
- [ ] **Step 5: Self-review/commit/report.** `feat: inventory scoped Figma components and styles`; path-scoped files из task. Report содержит RED/GREEN, full result, files, interfaces и concerns; task reviewer сравнивает с original spec, а не только с этим планом.

### Task 2: Variable bindings и явные mode observations

**Files:** Create `plugins/figma-ops/scripts/figma_ops_bindings.py`, `plugins/figma-ops/tests/test_bindings.py`; Modify `plugins/figma-ops/tests/bindings_fixtures.py`; regenerate legacy runtime.

**Interfaces:**
- Consumes `extract_library(scope) -> Collected`, existing scope/identity/provenance conventions Task1.
- Produces `extract_bindings(scope: LoadedScope) -> Collected` с полными семью data lists spec. Дополнительно `referenced_variable_ids(bindings: Collected) -> list[str]`, `observed_collection_ids(bindings: Collected) -> list[str]`: stable unique exact IDs для Task3/4. Library coverage переносится без суммирования scanned_nodes второй раз; per-field counters дополняются, missing/invalid counts не смешиваются.
- Fixtures produces `bindings_payload() -> dict`: fresh library_payload с добавленными bindings/mode observations; исходный library_payload не меняет поведение.
- Flat variable_binding row: `node`, `container_role`, `container_pointer`, `raw_container`, `raw`, `reference_id` nullable, `definition_state='not_requested'`, provenance pointer к конкретному alias/повреждённому значению. Один row на alias; повреждённый контейнер без alias получает raw row/reference_idnull. Некорректные/unknown соседние values также сохраняются raw row, не исчезают при наличии valid alias. Mode row: `node/collection_id/mode_id/raw/location/provenance`.

- [ ] **Step 1: Написать RED extraction tests.** Fixture включает node.boundVariables.size.x/y, individualStrokeWeights, componentProperties map, fontSize/fills/textRangeFills arrays; nested paints/gradientStops/effects/layoutGrids/style/styleOverrideTable/componentProperties с boundVariables. Полные property keys и `/`/`~` в них проверяют escaping. Родитель root имеет collection c→mode c:dark, root/descendant — другие explicit maps; source ancestors внутри широкого root не дублируются.

```python
# test_nested_binding_pointers_preserve_alias_shape_and_raw
assert row['reference_id'] == 'v.color'
assert row['provenance']['json_pointer'] == '/fills/0/boundVariables/color'
assert row['definition_state'] == 'not_requested'
assert row['raw_container'] == source['fills'][0]['boundVariables']
# test_modes_are_observations_not_effective_resolution
assert observed_collection_ids(result) == ['c']
assert all('effective_mode' not in x and 'resolved_value' not in x for x in result.data['mode_observations'])
```

Named tests: valid alias containers перечисленного OpenAPI формата не дают partial; malformed alias id/list/null/unknown type рядом с valid сохраняет raw+partial; absent/{} /null counters различены; fake aliases внутри pluginData/annotations/interactions не входят в reference IDs и не интерпретируются; неизвестная вложенность в разрешённом property container сохраняется с warning/partial без придуманной semantic role; глубина1200 nodes и1200 nested JSON без RecursionError; composite IDs не нормализованы; ancestor mode location/scanned count/dedup; inputs immutable и порядок aliases стабильный. Все normal wrapper maps внутри node.boundVariables (`size`, weights, componentProperties, arrays) распознаются как известные структуры, а не unknown alias.

`test_alias_looking_external_payload_is_not_binding`: добавить pluginData с VARIABLE_ALIAS/id='fake', assert `'fake' not in referenced_variable_ids(result)` и `result.partial is False` при остальных valid полях. `test_present_empty_missing_invalid_binding_fields`: на scope из одной ноды для absent/{} /null assert соответствующий counter1 и `partial == False/False/True`; raw null сохранён. `test_deep_alias_container_and_tree_are_iterative`: depth1200, один valid alias ровно один раз и никаких RecursionError.
- [ ] **Step 2: RED.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_bindings.py' -v` — FAIL missing extractor/import.
- [ ] **Step 3: Реализовать collector и helpers.** Итерировать только названные spec property containers, исключая `children` при JSON-walk одной ноды; children обходятся внешним DFS единожды. Container roles распространять по известной структуре, unknown path не получает документированную семантику по имени ключа. Mode observations: root_ancestors, затем root DFS; не вычислять inherited/default mode. Helpers отдают только валидные непустые exact IDs.
- [ ] **Step 4: GREEN/retained checks.** bindings/library suites — OK; sync и полный unittest suite — OK; diff check пусто. CLI ещё не регистрировать, flags/docs/versions не менять.
- [ ] **Step 5: Self-review/commit/report.** `feat: extract exact Figma variable bindings and mode observations`; reviewer проверяет границы containers, truthiness/raw, pointers и отсутствие scope expansion.

### Task 3: Необязательные definitions и ограниченный данными alias closure

**Files:** Create `plugins/figma-ops/scripts/figma_ops_variables.py`, `plugins/figma-ops/tests/test_variables.py`; Modify `plugins/figma-ops/tests/bindings_fixtures.py`; regenerate legacy runtime.

**Interfaces:**
- Consumes `ApiResponse`, `Collected`; reference_ids/collection_ids из Task2. Этот task не делает GET.
- Fixtures produces `variable_payload() -> dict`: fresh synthetic definitions/collections response для pure и последующих integration tests; не зависит от live данных.
- Produces `extract_variables(response: ApiResponse, file_key: str, reference_ids: list[str], *, collection_ids: list[str] | None = None) -> Collected`; data `variables/variable_collections/alias_links/unresolved_references`; coverage request_scope=file-variable-metadata, completefalse, requested/available/unresolved reference counts, file-catalog vs collected counts, `reference_states: dict[str,str]` (`available|unresolved`) для каждого встреченного reference. Это metadata availability, не resolved value.
- Variable row `mapping_key/raw/provenance`; collection row аналогично. Alias link `source_variable_id/source_collection_id/mode_id/reference_id/json_pointer/provenance` с nullable IDs по месту исходного payload. Unresolved `reference_id/reason/provenance`, reason `not_returned|ambiguous_reference|deleted_but_referenced|malformed`; повреждённые candidate records сохраняются raw. Metadata version не становится document version.

- [ ] **Step 1: Написать RED pure graph tests.** variable_payload — полноценный synthetic `status200/errorfalse/meta` с dictionary variables/collections и modes **array**. A→B→A в valuesByMode; C unrelated. Alias refs match mapping key/id/subscribed_id; stable key не lookup identity. Другие values — false,0,'',RGBA, composed color с отдельными color/opacity aliases; codeSyntax WEB/ANDROID/iOS и неизвестные fields raw.

```python
# test_alias_cycle_keeps_raw_definitions_without_resolving_values
assert {v['mapping_key'] for v in result.data['variables']} == {'A', 'B'}
assert len(result.data['alias_links']) == 2
assert result.coverage['reference_states']['A'] == 'available'
assert result.data['variable_collections'][0]['raw']['modes'] == [{'modeId':'m','name':'Default'}]
assert all('resolved_value' not in v for v in result.data['variables'])
```

Отдельные tests: remote subscribed_id сохраняется без конверсии; collision ref→две records даёт ambiguous/unresolved, обе candidate raw видны, aliases от неоднозначных candidates не расширяются; deleted definition retained+unresolved; отсутствующая/повреждённая definition не скрывает valid; malformed meta/maps даёт Collectedpartial с доступными частями; alias глубиной1200 и cycle не переполняют recursion; отсутствующие modes/неверный modes type различаются; snapshot/cache provenance.

Для extended collections: seed collections = явно наблюдённые collection IDs + collections выбранных variables; включить доступных parents/root по exact IDs, с visited. Обрабатывать overrides **только для variables в выбранном closure**, добавляя их aliases до fixed point; unused override на X не подтягивает X/Y. Parent cycle прекращается с warning/partial, raw relations сохраняются. Сами extended/composed fields не являются ошибкой; никаких effective/default calculations. Test проверяет overrides A→B и unused X→Y, отсутствие X/Y и посторонней collection, raw parentModeId/override/defaultModeId сохранены.

`test_ambiguous_identity_preserves_candidates_without_expansion`: две records с subscribed_id='shared' и разными targets, assert `result.coverage['reference_states']['shared'] == 'unresolved'`, `reason == 'ambiguous_reference'`, targets отсутствуют в closure. `test_unused_extension_override_does_not_expand_catalog`: assert selected mapping keys `== {'A','B'}`, 'X'/'Y' отсутствуют, исходный override payload равен raw после extraction. `test_collection_parent_cycle_is_bounded_partial`: c1→c2→c1 даёт ровно две collection rows, `result.partial is True`, обе parent IDs raw сохранены.
- [ ] **Step 2: RED.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_variables.py' -v` — FAIL missing module/function.
- [ ] **Step 3: Реализовать response validation/index/closure.** Индекс identity→набор mapping keys из mapping key/id/subscribed_id (дубликат одной record не создаёт ambiguity). Stable discovery queue с visited refs/records/collections; aliases links сохраняются без value evaluation, unknown payload остаётся raw warning. Valid direct reference может быть available при unresolved downstream alias; section при этом partial, а не ложно вычисленное значение. Повреждение unrelated catalog entry не должно удалить корректные выбранные definitions: scan counters отмечают проблемы, partial допустим, полный catalog не выдавать.
- [ ] **Step 4: GREEN/retained checks.** variables suite — OK; bindings/library suites остаются OK; sync/full suite — OK; diff check пусто. Ни transport, ни metadata endpoint handler в этом task не менять.
- [ ] **Step 5: Self-review/commit/report.** `feat: collect used Figma variable definitions and alias evidence`; reviewer проверяет closure boundaries, collisions, extension overrides и отсутствие guessed resolution.

### Task 4: bindings CLI и opt-in context без повторного nodes GET

**Files:** Create `plugins/figma-ops/scripts/figma_ops_design_system.py`, `plugins/figma-ops/tests/test_design_system.py`; Modify `plugins/figma-ops/scripts/figma_ops_scope.py`, `figma_ops_context.py`, `figma_ops.py`, `plugins/figma-ops/tests/test_context.py`, `test_cli.py`, `test_packaging.py`, `bindings_fixtures.py`; regenerate legacy runtime.

**Interfaces:**
- Consumes Tasks1–3 exact functions и existing `load_scope/project_prototype` (итеровая deep-copy projection всех верхнеуровневых lists).
- Scope produces shared helpers `collected_section(result: Collected,response: ApiResponse,*,version: str | None = None) -> dict`, `empty_section(state: str,source: str = 'figma-rest') -> dict`, `scope_context(scope: LoadedScope,*,url_node_id: str | None) -> dict`. Перенести прежние context wrappers/identity construction без изменения outputs/default keys; scope_context даёт source_node/scope_root/url_node_id/ancestors/page/suggested_context_roots.
- New module produces `collect_design_system(scope: LoadedScope,client: Client,*,with_variables: bool = False,limit: int | None = None) -> dict` с keys `sections`, `next_actions`; `bindings(args,client: Client) -> dict`. Collector не делает load_scope, вызывает extract_bindings один раз и optional variables GET/extractor один раз; handler загружает scope и добавляет envelope/identity/snapshot consistency.
- Update valid binding rows definition_state через full variables.coverage.reference_states **до projection**; skipped→not_requested, requested but endpoint failed/missing→unresolved. Direct available не означает alias resolved value. Section coverage.cache от своего ApiResponse, variables.version всегдаnull; безопасный OpsError только локально в variables section, без blanket catches.

- [ ] **Step 1: Написать RED integration tests на реальном CLI/CurlBoundary.** Команда bindings TARGET требует node, принимает scope-root/with-variables/limit/common flags. URL2:2 overridden --node2:1 остаётся url_node_id2:2; scope-root2:0 один files GET с ids2:1,2:0. No flags variables not_requested, single-response и ok даже при missing optional fields; malformed bindings partial, useful metadata остаётся.

```python
# test_bindings_optional_variables_forbidden_preserves_inventory
assert (code,result['status']) == (0,'partial')
assert paths == ['/v1/files/Key','/v1/files/Key/variables/local']
assert sections['bindings']['state'] == 'collected'
assert sections['variables']['state'] == 'failed'
assert sections['variables']['error']['code'] == 'forbidden'
assert sections['variables']['version'] is None
assert result['data']['snapshot_consistency'] == 'independent-requests'
# test_context_enrichment_reuses_already_loaded_scope
assert paths == ['/v1/files/Key','/v1/files/Key/comments','/v1/files/Key/variables/local']
assert len(sections['comments']['data']['threads'][0]['replies']) == 2
assert sections['variables']['version'] is None
```

Named regressions:403/429/200malformed variables; per-record malformed definitions partial; source failure before enrichment error; successful source/variables timestamps/cache differ and document version only source; without-comments+with-bindings one GET, with-variables two; normal context remains exactly six prior sections/two host hints and old source/root/coverage/status; with-bindings adds exactly bindings/variables and host hints for variable defs/CodeConnect reading, preserving motion/canvas actions. Context order fixed source→comments(ifrequested)→variables(ifrequested), ошибки comments не блокируют variables и наоборот. MCP/CodeConnect hints — данные на exact root, без обещания tool availability.

Argument matrix before GET: no node, empty IDs, limit0, `context --with-variables` без --with-bindings. Sibling root остаётся scope_mismatch после одного GET. Limit1 отдельно для всех lists с полными counters; raw properties/overrides не обрезаются; output сохраняет всё. Query flags после subcommand, branch/compositeIDs, deep/projected consumer edits не меняют исходные response/cache objects.
- [ ] **Step 2: RED.** `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_design_system.py' -v` и новые context cases — ожидаемый FAIL отсутствующий command/flags/sections; сохранить output.
- [ ] **Step 3: Реализовать shared helpers и orchestration/flags.** Общий source/root validation и projection; GET variables fixed API path без иных endpoints/повторов. Bindings envelope initial metadata, scanned count source only, completefalse; single-response только без requested enrichment. В context новые flags false по умолчанию и условное добавление sections; обычный context не начинает использовать новые fields/GET/hints. Error state безопасный и локальный. CLI common-flags loop дополнить одиннадцатой командой.
- [ ] **Step 4: GREEN command/compatibility suites.** design_system/context/CLI suites OK; добавить bindings в COMMANDS и одиннадцатую standalone operation с synthetic component/style/alias fixture. Counts временно обновить до11operations/12helps на root; final версии/шестой reference остаются Task5. Sync, полный suite OK; diff check пусто. Старые tests не ослаблять ради нового context.
- [ ] **Step 5: Self-review/commit/report.** `feat: expose scoped design-system bindings in CLI and context`; reviewer считает запросы, сравнивает default context с исходной spec/retained contracts, проверяет conditional flag validation и error isolation.

### Task 5: Workflow, standalone release и фактическая приёмка

**Files:** Modify `plugins/figma-ops/skills/figma-ops/SKILL.md`, `references/reading.md`, `references/context.md`, `references/auth.md` внутри canonical skill, `plugins/figma-ops/README.md`, `plugins/figma-lookup/README.md`, `README.md`, `plugins/figma-ops/tests/test_packaging.py`; Create `plugins/figma-ops/skills/figma-ops/references/bindings.md`, `docs/superpowers/research/2026-10-23-figma-ops-iteration-3-verification.md`; Modify four `.claude-plugin/.codex-plugin/plugin.json` under both plugins and both `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`; regenerate legacy skill/references/runtime.

**Interfaces:** Consumes11commands/sections/coverage Tasks1–4; produces canonical1.2.0/legacy1.3.0, шесть references, одинаковые skill bodies/runtime и sanitized report. Controller выполняет OLD/NEW native routing evaluations и live reads; worker не запускает дочерние агенты или child CLI. Установка не переключается на незавершённую ветку.

- [ ] **Step 1: Controller freeze OLD до изменения skill.** Snapshot canonical skill+references и шесть held-out synthetic scenarios в игнорируемой папке этого плана. Сценарии проверяют ID/key/fileKey, used refs/catalog, metadata/effective values, modes/alias shape, REST403 при рабочем MCP и partial/source-root/budget. Приватную rubric не давать worker/evaluator; scenarios/IDs/values не копировать в product examples. Fresh native evaluator только выбирает действия, не выполняет инструменты. OLD может решить всё — не выдумывать RED. Исторический запрет inference child CLI не повторять; разрешение curl его не отменяет.
- [ ] **Step 2: Packaging RED.** Assert версии1.2.0/1.3.0 во всех manifests/catalogs, references exactly `{auth.md,reading.md,comments.md,assets.md,context.md,bindings.md}`, equality/idempotence всех modules/body. Каждый root без sibling из cwd с пробелами запускает11operations и12help calls. Synthetic bindings проверяет exact source/component/style/variable IDs, properties false/empty/SLOT, context with-bindings отдельно; opt-in successful definitions и403partial — дополнительные сценарии, не увеличивать базовый operation_count. `python3 -B -m unittest discover -s plugins/figma-ops/tests -p 'test_packaging.py' -v` — expected FAIL versions/reference contract.
- [ ] **Step 3: Обновить metadata/workflow.** Compact main skill routes к bindings reference. Описать1/2GET иcontext reuse, source/root, raw aliases/modes arrays/SLOT, отсутствующие definitions, request_scope metadata, host discovery get_variable_defs и read-only CodeConnect. Auth reference: file_content:read для bindings, file_variables:read + Enterprise/account requirement для optional endpoint;403 не диагностирует точную причину. Не обещать MCP ID mapping/atomic snapshot/effective values, не исполнять documentationLinks. Сохранить geometry/QR/assets/полные threads и official prerequisites.
- [ ] **Step 4: GREEN и fresh NEW.** Sync, packaging suite OK:22базовые operations/24help calls между двумя roots, дополнительные enrichment/partial cases отдельно с фактическими counts. После freeze skill controller запускает NEW evaluator на тех же held-out cases, оценивает OLD/NEW честно, отражает различия и ограничения simulation в report. Это не host activation, не доказанный quantitative gain при одинаковых результатах.
- [ ] **Step 5: Локальные проверки.** Полный `python3 -B -m unittest discover -s plugins/figma-ops/tests -v` — OK, count измерить; `git diff --check` пусто. AST feature_version=(3,10) canonical/generated runtime +sync — ожидаемо31file при четырёх новых runtime modules, печатать фактическое N и interpreter version, runtime3.10 отдельно. Два `python3 /Users/y.mihalev/.codex/skills/.system/skill-creator/scripts/quick_validate.py <skill-root>` для canonical/legacy — exit0/valid; без установки dependencies, при недоступности честно непроверено с packaging fallback. Controller scan публикуемых paths по известным private IDs без вывода значений. Не повторять успешные suite без новых изменений/сомнений.
- [ ] **Step 6: Controller live и sanitized report.** На ранее разрешённом узком subtree новые bindings возвращают реальные scoped instances/style/variable refs; с --with-variables текущий403 сохраняет useful partial (если доступ изменился, описать фактический результат). Context --with-bindings повторно не читает nodes, сохраняет source/root и полный thread. При доступном get_variable_defs отдельный read-only MCP evidence и counts; не импортировать его strings в REST graph. Положительный RESTdefinitions/SLOT/extended fields не заявлять live-проверенными при отсутствии доступного источника. Нет дизайновых edits/настройки credentials. Приватные payloads только в игнорируемой папке текущего плана; tracked report содержит только technical counts/границы/spec+README links и все controller rulings с costs.
- [ ] **Step 7: Commit и branch review.** `feat: publish design-system bindings workflow for both plugin names`; controller может отдельным docs commit завершить report после итогового review. Все task reviews + whole-branch strongest reviewer по исходной spec; найденные defects исправить/повторно проверить по SDD, не подменять review simulation. Controller один независимый final full suite на окончательном runtime, без бессмысленного повторения одинаковых проверок. Ветка/worktree остаются, no push/PR/merge/install. При следующем поручении PR ready for review.

## Самопроверка плана по спецификации

| Требование spec | Реализация и проверка |
|---|---|
| Used components/styles, exact IDs, property keys/SLOT/overrides и dependency distinction | Task1 |
| Nested aliases/known container roles, raw/provenance/escaping/deep trees | Task2 |
| Mode observations без inferred values/ancestor dedup | Task2 |
| Optional definitions, identity collisions, local alias closure/extended/raw/cycles | Task3 |
| Source/root, schema/envelope/metadata/limits/errors и1/2GET | Task4 |
| Default context compatibility и opt-in reuse/independent sections | Task4 |
| MCP get_variable_defs/CodeConnect reading, no guessed mapping/effective computation | Task5 workflow/routing/live |
| Versions, six refs, standalone/generator/eleven commands | Tasks4–5 |
| Auth/privacy/read-only/current403/no credential changes/no childCLI retry | Global constraints/Task5 acceptance |
| Review Focus1–5 | Task1 IDs;Task2 unknowncontainers/deep;Tasks1–2false/empty/SLOT;Task3cycles/unusedoverrides/collisions;Task4failedoptional/no extraGET |

Step/type scan: task signatures объявлены до потребителей; Task4 получает variables.coverage['reference_states'] из Task3 и full reference IDs Task2 до проекции; wrapper/identity extraction сохраняет прежний context. Сетевой collector только Task4, pure functions не получают client. Четыре новых runtime modules автоматически попадают в generator/equality; versions/reference contracts меняются только Task5. План содержит решения/interfaces/assertions, не тела реализации. Продуктовых изменений на этапе планирования нет.
