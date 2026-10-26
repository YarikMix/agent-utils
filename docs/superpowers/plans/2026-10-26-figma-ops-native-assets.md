# Figma Ops Native Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать PNG export через Southleft Bridge штатным сценарием с безопасным сохранением на host и offline-проверкой реальных pixels.

**Architecture:** Агент вызывает targeted read-only JS recipe, host сохраняет bytes новым файлом, отдельный Python entrypoint проверяет PNG существующим decoder. REST dispatcher и 11 operations сохраняются. Compatibility distribution генерируется существующим sync tool.

**Tech Stack:** Python 3.10+ stdlib/unittest, JavaScript Plugin API, Markdown recipes, JSON manifests. Node нужен только development-тестам JS, без новых dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-figma-ops-native-assets-design.md`; основание — `docs/superpowers/research/2026-10-26-figma-ops-rest-parity.md`. Пользователь поручил составить этот план; выполнение начинается отдельно после его просмотра.

## Global Constraints

- Поддерживается PNG. SVG/PDF/JPG/fills/QR, variable resolver, motion, запись в Figma, token migration, общий importer MCP JSON, удаление REST и optional companion package вне scope.
- Python 3.10+ stdlib; не создавать Client, не разрешать credentials, не вызывать curl/security/MCP из verifier, не читать response cache/.env/конфиги, не записывать input/output файлы verifier-кодом.
- Native input: expectedFileKey, nodeId, scale (default 2, finite 0.01..4), maxBytes (default 1048576, integer 1..4194304).
- FileKey guard до lookup. Никаких children/page scans, selection changes, create/remove/import, временных заливок или smart resize. Composite IDs сохраняются целиком.
- maxBytes — предел raw bytes до base64; oversized export даёт partial/export_size_limit без base64 и downscale. Не обещать ограничения памяти, уже выделенной Figma.
- Offline input — читаемый обычный файл, bounded read максимум 64 MiB + один sentinel byte. Формат PNG проверяет существующий inspect_image, не extension.
- Expect-width/expect-height — positive integers, вместе либо оба отсутствуют. Require-transparency принимает только подтверждённые прозрачные pixels; unknown не считается успехом требования.
- Native receipt не доказывает pixels/alpha/version; local receipt source=local-file, provenance_verified=false, без фиктивных fileKey/version и общего verified=true.
- Exit0 — требования проверены; exit1 — input/validation/verification error; exit2 — invalid arguments; help exit0. Ошибки CLI — JSON без traceback/bytes.
- Сохранить 11 прежних operations/schema/budgets/auth и decoder. Упаковка: canonical 1.4.0 / alias 1.5.0, 16 runtime modules, восемь references в каждом автономном root.
- Текущий worktree `/Users/y.mihalev/projects/agent-utils-figma-ops-native-assets`, base `4623096dc4b6eaa714d887e9a0f66c803853880f`; основные checkout и установленные skills не менять. Во время исполнения без git add/commit/reset/stash/restore; reviews по scoped snapshots. Push/PR/merge и обновление установок отдельно.
- Policy denial/429 не обходить другим транспортом. Live только exact connected target, без mutations и принудительного UI reconnect. Исторический artifact не называется новым live capture; запрещённую external child inference не повторять.

## Review Focus

- Байты PNG корректны, но scale/target provenance не подтверждены: passed pixels не превращаются в доказательство происхождения — Tasks 1/2.
- Недоступная прозрачность после потокового decode: require-transparency должен завершаться error/unavailable — Task 1.
- Выдача export больше cap либо transport потерян: никакого base64/resize/объявления сохранённого файла — Task 2.
- Существующий destination или повреждённый payload: host handoff сохраняет прежний файл и не оставляет новую пустую заготовку при preflight-ошибке — Task 2.
- Установлен только alias, cwd с пробелами, PAT/Node отсутствуют: Python verifier остаётся автономным — Task 3.

## Карта файлов и ответственность

| Task | Files | Ответственность |
|---|---|---|
| 1 | Create `plugins/figma-ops/scripts/figma_asset_verify.py`, `plugins/figma-ops/tests/test_asset_verify.py` | Offline receipt, проверки файла/requirements, CLI |
| 2 | Create `plugins/figma-ops/skills/figma-ops/references/native-assets.md`, `plugins/figma-ops/tests/test_native_assets.py`, `plugins/figma-ops/tests/recipe_harness.py`; modify canonical `SKILL.md`, references `assets.md`/`mcp-routing.md`, `tests/test_mcp_recipes.py` | Actual export/save recipes, workflow, общий test harness, regression M1 |
| 3 | Modify оба plugin README, четыре host manifests, два catalogs, `tests/test_packaging.py`; generate legacy runtime/skill/references; create verification report | Установка, совместимость, полная приёмка |

Runtime files первой итерации, включая `figma_ops.py`, `figma_ops_core.py`, `figma_ops_assets.py`, `figma_ops_image.py`, остаются побайтово прежними. Test-only harness не копируется в plugins runtime.

---

### Task 1: Автономная проверка локального PNG

**Files:** Create `plugins/figma-ops/scripts/figma_asset_verify.py`, `plugins/figma-ops/tests/test_asset_verify.py`. Read existing `scripts/figma_ops_image.py`, `scripts/figma_ops_core.py`, `tests/test_image.py`.

**Interfaces:**
- `verify_file(path: Path, *, expect_width: int | None = None, expect_height: int | None = None, require_transparency: bool = False) -> dict` возвращает весь receipt, включая error; ожидаемые ошибки не выбрасываются наружу.
- `main(argv: list[str] | None = None) -> int` выводит один strict JSON receipt и возвращает exit code; `--help` — обычная справка. `if __name__ == '__main__'` завершает процесс кодом main.
- `MAX_INPUT_BYTES = 64 * 1024 * 1024`. Существующий `inspect_image(content, 'png')` — единственный decoder.
- Receipt: `{schema_version:1, operation:'verify-asset', source:'local-file', status, checked_at, data, warnings, error}`. `checked_at` — UTC с Z. `data`: path (строка переданного path; null, если FILE не удалось разобрать), bytes (int/null), format='png', width/height (int/null), alpha, expected `{width,height,require_transparency}`, checks `{valid_png,width,height,transparency}`, provenance_verified=false. Checks — строки passed|failed|unavailable|not_requested. Для input error сохранять shape с unknown/null metadata, не выдумывать результат decode.
- Safe codes: invalid_argument, invalid_file, file_read_failed, asset_too_large; ошибки decoder сохраняют OpsError.code. Failed dimensions/opaque requirement → asset_mismatch; unknown required alpha → verification_unavailable. Если несколько требований нарушены, вычислить все checks: failed имеет приоритет над unavailable.

- [x] **Step 1: Добавить failing tests публичных интерфейсов.** `test_transparent_png_requirements`, `test_opaque_without_requirement`, `test_opaque_requirement_fails`, `test_dimension_mismatch_retains_metadata`. Использовать `png` из `test_image`, без нового PNG encoder. Для transparent 1×1 sample assertions:

```python
receipt = verify_file(path, expect_width=1, expect_height=1, require_transparency=True)
self.assertEqual((receipt['status'], receipt['source']), ('ok', 'local-file'))
self.assertEqual(receipt['data']['checks']['transparency'], 'passed')
self.assertIs(receipt['data']['provenance_verified'], False)
self.assertEqual((receipt['data']['width'], receipt['data']['height']), (1, 1))
```

Также: opaque без требования → ok/not_requested; opaque с требованием → error/asset_mismatch; неверные dimensions → error с сохранёнными фактическими width/height; valid_png прошёл, но происхождение не подтверждено.
- [x] **Step 2: Написать error-boundary tests.** `test_input_errors_do_not_write`, `test_input_read_is_bounded`, `test_corrupt_png_preserves_decoder_error`. Missing/directory/non-regular (FIFO где поддерживается) → error без блокировки; unreadable file → file_read_failed; повреждённый/обрезанный PNG → decoder error; sparse file размером MAX_INPUT_BYTES+1 → asset_too_large. Дополнительно проверить bounded read count/размер запроса, чтобы stat не был единственной защитой при изменении файла. После каждого case hash input и список файлов в test directory прежние.
- [x] **Step 3: Написать test_unknown_alpha_requirement_uses_real_streaming_decoder.** На tiny valid PNG временно уменьшить `figma_ops_image.MAX_DECODED` в test patch: потоковый путь реально выполняется и возвращает warnings/unknown без огромной fixture. Без требования → ok; с требованием → error/verification_unavailable и checks.transparency=unavailable. Дополнительный маленький Adam7 sample из existing fixture допустим; не переписывать decoder ради теста.
- [x] **Step 4: Написать CLI/no-side-effects tests.** `test_cli_argument_and_exit_contract`, `test_import_and_main_do_not_touch_credentials_or_network`. Positive integer pair/оба отсутствуют; один флаг, 0, negative, non-int и неизвестные network/output flags → exit2 + JSON invalid_argument. Input/verification errors → exit1; help/valid PNG → exit0. In-process guards запрещают Client/resolve_token, обращения к FIGMA_TOKEN/FIGMA_ACCESS_TOKEN, subprocess/socket/cache access; они должны срабатывать на import и main, а не только на happy-path функции. Guard обычных stdlib locale/interpreter операций не выдавать за доступ verifier к credentials. В тестах отключить interpreter bytecode writes; не переназначать HOME/CODEX_HOME.
- [x] **Step 5: Запустить RED.** `python3 -m unittest discover -s plugins/figma-ops/tests -p test_asset_verify.py -v`. Нужен ожидаемый failure отсутствующего helper/interface, не ошибка fixture или случайный PASS.
- [x] **Step 6: Реализовать verify_file/main по контракту.** Проверить аргументы, regular file/read cap, прочитать bounded bytes, переиспользовать decoder и вычислить requirements. Не использовать REST envelope helper, фиксирующий source=figma-rest. Выбранные сигнатуры/receipt не менять в следующих tasks.
- [x] **Step 7: Запустить focused GREEN**, включая CLI subprocess из cwd с пробелами и пустым PAT; `python3 -m unittest discover -s plugins/figma-ops/tests -p test_asset_verify.py -v`. Зафиксировать команды/вывод RED/GREEN и self-review в task report. Полный suite здесь не повторять без конкретной причины; packaging следующей версии ещё не меняется.

### Task 2: Native export и host handoff как исполняемые examples

**Files:** Create `references/native-assets.md`, `tests/test_native_assets.py`, `tests/recipe_harness.py` в canonical plugin; modify `skills/figma-ops/SKILL.md`, `references/assets.md`, `references/mcp-routing.md`, `tests/test_mcp_recipes.py`.

**Interfaces:**
- Consumes Task 1 standalone command и receipt; verifier не принимает MCP JSON/base64 вместо файла.
- Test utility `load_recipe(reference: Path, marker: str, language: str = 'js') -> str`; `run_js_recipe(reference: Path, marker: str, fixture: dict, inputs: dict) -> dict` возвращает result/error, accesses, export_calls (список `{nodeId, settings}`), base64_calls (int). Перенести existing JS harness сюда без копии; existing class.run_recipe остаётся тонким wrapper, прежние 14 tests сохраняются.
- Markdown markers: `native-png-export` (JS) и `native-png-save` (Python). JS потребляет `input`, Python — уже извлечённый `capture: dict` и `destination: Path`. Host-specific MCP content wrapper разбирает сам host; универсальный importer не добавляется.
- Capture: `{status:'ok'|'partial', fileKey,nodeId,version:null,source:{width,height,render_bounds},scale_requested,format:'png',byte_count,max_bytes,reason:null|'export_size_limit',base64?}`. Metadata nullable при неподдержанных полях; они не препятствуют export, но не подставляются догадкой. Oversized receipt не содержит base64. Явные invalid/missing/unsupported inputs бросают понятную ошибку; export API rejection не превращается в успешный receipt или generic error, скрывающий policy/429.
- Python handoff валидирует status, PNG format, integer byte_count/max_bytes (1..4194304), длину encoded payload и strict base64, сравнивает decoded length с byte_count **до** exclusive создания destination (`xb`). Декодирование/ошибка metadata не оставляют новый файл; existing destination не меняется. Успешный handoff подтверждает сохранённые bytes, не PNG pixels/provenance.

- [x] **Step 1: Снять baseline до изменения skill.** Зафиксировать old skill/references и отдельные held-out native-export задачи: capped preview, oversized native payload, existing destination, неизвестные bounds/alpha, offline verifier без PAT, потерянный transport. Expected checks не показывать evaluator и не переносить targets/ответы в examples. Fresh external inference не запускать вопреки прежнему policy; explicit-file application ограничивать именно чтением файлов, без claims host activation или численного before/after gain.
- [x] **Step 2: Вынести test harness и добавить M1.** Утилита получает reference явно; fixture умеет exported bytes/rejection/call log и throwing ordinary-field getter. Existing 14 tests остаются зелёными. Добавить для bounded-subtree assertions: annotations.state=unavailable, partial=true, field_unavailable в frontier; visible=False, opacity=0 и child сохранены. Это coverage корректного поведения, не заявлять здесь исправление продукта или искусственный RED.
- [x] **Step 3: Написать failing native recipe/handoff tests.** `test_native_export_defaults_exact_id_and_no_mutations`, `test_export_bounds_reject_before_lookup`, `test_export_cap_omits_binary_without_resizing`, `test_host_save_preflight_and_exclusive_create`. Wrong file → accesses пуст; lookup exact composite ID; scale default2 и пределы .01/4; invalid finite/type/range и maxBytes не вызывают export. Native calls должны получить ровно `{'format':'PNG','constraint':{'type':'SCALE','value':2}}`. Проверить unsupported/missing/empty export и API rejection, отсутствие scan/mutations/resize. Unsupported source geometry getter даёт null metadata, без выдуманной геометрии и без потери успешного export.

```python
out = run_js_recipe(reference, 'native-png-export', fixture, inputs)
self.assertEqual(out['result']['status'], 'partial')
self.assertEqual(out['result']['reason'], 'export_size_limit')
self.assertNotIn('base64', out['result'])
self.assertEqual(out['base64_calls'], 0)
```

Для byte_count==maxBytes ожидается ok с точными decoded bytes; больше cap — один export в исходном scale, без повторов/downscale/base64Encode. PNG dimensions/alpha recipe не объявляет verified.

Успех → decoded bytes на диске равны export fixture; malformed base64, byte_count mismatch, partial receipt, oversized encoded/decoded payload → destination отсутствует; existing destination с sentinel bytes остаётся прежним. Ни одна capture string не исполняется как код/path. Вручную прерывать write ради test data loss не нужно; неизвестный исход записи не объявлять успешным.

- [x] **Step 4: Запустить RED.** `python3 -m unittest discover -s plugins/figma-ops/tests -p test_native_assets.py -v`: отсутствуют native reference/markers. Tests исполняют actual Markdown code, не duplicate algorithm. При отсутствии Node явно описать skip, не выдавать skipped за JS GREEN.
- [x] **Step 5: Добавить native-assets.md с обоими blocks и workflow.** Guard expectedFileKey до lookup; PNG-only exportAsync и figma.base64Encode; никакого доступа к Mac path из plugin. Host preflight/save — Python stdlib, без HTTP/config/credentials. Не уменьшать scale автоматически; maxBytes raw, encoded примерно 4/3; byte cap не ограничивает уже выделенный buffer. Empty export считать явной ошибкой, не готовым файлом.
- [x] **Step 6: Обновить assets/main/routing ссылки и guidance.** У main skill остаётся короткая ссылка на native workflow, CLI path разрешается относительно загруженного plugin root. Pixel checks через Task 1; expected pixels требуют независимых bounds, alpha channel не доказывает прозрачность. При transport loss/недоступном безопасном writer назвать конкретный пробел. Сохранить прежние геометрию/QR/fills/REST guidance, policy/429 и официальный MCP prerequisites.
- [x] **Step 7: Focused GREEN и применение нового текста.** Запустить `python3 -m unittest discover -s plugins/figma-ops/tests -p 'test_*assets.py' -v` и `python3 -m unittest discover -s plugins/figma-ops/tests -p test_mcp_recipes.py -v`. Применить новую редакцию к тем же held-out задачам, отдельно от реальной host activation. Report содержит новые/старые tests, границы и self-review; legacy drift до Task 3 ожидаем.

### Task 3: Самостоятельная упаковка, версии и итоговая проверка

**Files:** Modify `plugins/figma-ops/README.md`, `plugins/figma-lookup/README.md`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `plugins/{figma-ops,figma-lookup}/{.claude-plugin,.codex-plugin}/plugin.json`, `plugins/figma-ops/tests/test_packaging.py`. Generate legacy scripts/skill/references существующим sync. Create `docs/superpowers/research/2026-10-26-figma-ops-native-assets-verification.md`.

**Interfaces:** Consumes reviewed Tasks 1/2; produces canonical 1.4.0 / alias 1.5.0, 16 byte-identical runtime modules, восемь references и два standalone helper entrypoints. Existing runtime15/auth/decoder/dispatcher и sync script остаются прежними.

- [x] **Step 1: Обновить failing packaging expectations.** Версии 1.4.0/1.5.0, runtime count16, reference set8 с native-assets.md; не менять existing COMMANDS, 11 base operations/12 help/6 extra на root. Добавить `test_standalone_asset_verifier_from_cwd_with_spaces`: каждый plugin копируется в isolated root, cwd с пробелами, sibling отсутствует, verifier help + valid/error/invalid-arguments subprocess проходят с ожидаемыми codes/JSON. Для valid subprocess: `self.assertEqual((result.returncode, json.loads(result.stdout)['source']), (0, 'local-file'))`; все helper cases конкретизированы в Step 4.
- [x] **Step 2: Запустить packaging RED.** `python3 -m unittest discover -s plugins/figma-ops/tests -p test_packaging.py -v` до bump/sync. Ожидаемые несовпадения versions/count/reference/helper копии зафиксировать, случайные fixture ошибки исправить отдельно.
- [x] **Step 3: Обновить только Figma metadata/docs и выполнить sync.** README описывает native capture→exclusive save→verify; snapshot/provenance и PNG scope видимы. В четырёх manifests и двух catalogs согласовать версии, сохранить non-Figma entries. `python3 plugins/figma-ops/scripts/sync-compat.py` копирует 16 modules и eight refs; maintenance tool в alias не попадает, новый test harness остаётся test-only.
- [x] **Step 4: Доказать автономность helper в обоих roots.** Синтетический 1×1 transparent PNG + dimension pair + transparency → exit0; opaque+require-transparency → exit1/asset_mismatch; один dimension flag → exit2/invalid_argument. Input hash и destination directory unchanged; fake curl/security call log пуст, response cache не создан. Передать пустые Figma token variables, не менять HOME/CODEX_HOME. Считать отдельно: шесть helper cases и два helper help; прежние totals22/24/12 сохраняются.
- [x] **Step 5: Запустить полный suite один раз после интеграции.** `python3 -m unittest discover -s plugins/figma-ops/tests -v`: прежние 296 tests и новые tests PASS; count снять из фактического вывода. Проверить JSON parse, ссылки внутри каждого root, idempotence существующего sync test и `git diff --check`. Grammar check Python3.10 для нового helper/test modules отдельно от runtime версии interpreter.
- [x] **Step 6: Проверить фактический workflow при доступном Bridge.** Fresh probe/list + exact target → actual published export recipe → actual host save block → installed verifier с подтверждёнными expected pixels. При offline Bridge использовать разрешённый исторический artifact `/Users/y.mihalev/projects/agent-utils-figma-ops-mcp-routing/.superpowers/sdd/2026-10-26-figma-ops-mcp-routing/live-export.png`, только если он ещё существует; receipt из той же папки даёт прежние фактические dimensions. Это local historical verification, не новый live capture. Если artifact отсутствует, synthetic tests и конкретная live граница вместо выдуманного успеха. UI не перезапускать и дизайн не менять.
- [x] **Step 7: Написать sanitized verification report и сверить всю spec.** Разделить synthetic, historical/new-live и explicit-file application evidence; не публиковать corporate IDs/texts/values/изображения. Указать caps, неизвестный provenance и реальную поддержку transparent/unknown. Проверить, что старые15 runtime modules не изменились, Node не стал зависимостью installed helper, новых HTTP/auth путей нет. Task review, затем whole-branch review против spec; важные findings проходят scoped fixes/re-review.

## Проверка плана автором

Spec coverage: native recipe/host/pixels/provenance → Tasks1/2; offline/read/error/requirements limits → Task1; field getter M1/baseline → Task2; standalone/versions/sync/report/live limits → Task3. Review Focus имеет конкретные checks во всех owning tasks. Между задачами согласованы verify_file/main, локальный receipt, markers/inputs и packaging16/8; helper не получает MCP JSON.

План выбирает имена test utilities, JSON checks и safe error codes там, где spec оставляла builder решение. Новый код в план не переписан целиком; implementation bodies и внутренняя декомпозиция остаются исполнителю. После просмотра плана рекомендовано SDD: offline validator и два исполняемых examples имеют разные границы ошибок и требуют отдельных review gates. Этот документ не запускает реализацию, коммиты, push/PR или обновление установок.
