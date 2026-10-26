# Figma Ops MCP Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Научить figma-ops выбирать Southleft, официальный Figma MCP и существующий REST CLI по задаче, сохранив точную цель и проверяемый результат.

**Architecture:** MCP вызывает сам агент через текущий host. Skill и focused references описывают выбор, ограниченные read-only чтения и evidence; автономный Python CLI не меняется. Compatibility alias генерируется существующим sync-compat.py.

**Tech Stack:** Markdown, JSON manifests, Python 3.10+ unittest; установленный Node только для development-проверки JS recipes, без новых dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-figma-ops-mcp-routing-design.md` — согласована пользователем «делаем».

## Global Constraints

- Первая итерация обновляет маршруты; runtime CLI operations, auth, schema_version=1, exit codes, request budgets и headless работа сохраняются.
- Read-only: не менять макеты, comments, mappings, selection/page; не импортировать library entities ради чтения.
- Southleft targeted execute получает точный fileKey и проверяет figma.fileKey в code до чтения; tool без fileKey не связывается с файлом по старому activeFile.
- Official create_session/sessionId по текущей схеме; figma-use перед каждым use_figma, figma-design-to-code перед get_design_context, figma-use-motion для motion через use_figma.
- Полные comments/threads через существующий CLI auth; Southleft допустим с работающим PAT, include_resolved=true и сохранением root/replies/pins.
- Policy/organization denial и 429 не обходятся другим транспортом; Variables тарифный REST403 не равен запрету независимого Plugin API.
- Предлагаемые версии: canonical figma-ops 1.3.0, compatibility figma-lookup 1.4.0, в обоих catalogs и четырёх manifests согласованно.
- Без установки MCP, изменения Codex config, переноса токенов, переключения установленных skills, push/PR/merge.
- Результаты разных источников не получают фиктивную общую document version или CLI envelope; private live данные не попадают в tracked files.
- Работать в текущем изолированном worktree, без git add/commit/reset/stash/restore. Review packages собирает controller из scoped working-tree snapshots; main checkout и чужие файлы не менять.

## Review Focus

- Переключение активного файла между status и read: wrong fileKey останавливает recipe до node read — Task 1 recipe test.
- Нестандартный nodeId и вложенные actions[]: IDs и исходный JSON сохраняются без домыслов — Task 1 recipe tests.
- Огромный node payload/UTF-8 и предел глубины/числа нод: bounded результат с partial/frontier, без молчаливого обрезания raw — Task 1 recipe tests.
- Summary preview принят за asset 2× или API existence за прочитанные values: независимые held-out application scenarios + Task 2 verification report.
- Новый reference отсутствует в standalone alias/versions расходятся: existing sync/idempotence/isolated-root packaging checks — Task 2.

---

### Task 1: Canonical workflow и проверяемые Bridge recipes

**Files:**
- Modify: `plugins/figma-ops/skills/figma-ops/SKILL.md`
- Modify: `plugins/figma-ops/skills/figma-ops/references/{auth,reading,comments,assets,context,bindings}.md`
- Create: `plugins/figma-ops/skills/figma-ops/references/mcp-routing.md`
- Create: `plugins/figma-ops/tests/test_mcp_recipes.py`

**Interfaces:**
- Consumes: текущие host tool schemas, согласованную spec; controller снимает baseline до правки skill.
- Produces: краткий skill с task→route matrix, `mcp-routing.md` с маркированными fenced JS recipes, шесть согласованных references; unittest запускает извлечённые из Markdown recipes в Node с synthetic figma stub.
- Recipe inputs: явные expectedFileKey, nodeId/root и bounds; return JSON-safe result с identity, фактическим scope, observations и partial/frontier. Конкретные названия markers/receipt полей выбрать один раз и использовать и в документации, и в tests.

- [x] Step 1: Прочитать spec и существующие references. Использовать positive recipes и условные маршруты; не переносить held-out сценарии в examples.
- [x] Step 2: Добавить meaningful failing tests для recipes: wrong-file fails before node access; exact composite ID/ancestry; bounded subtree node/depth/byte cap; missing-vs-empty; raw nested actions/false/zero/unknown fields. Тест извлекает реальный JS из документа, а не копирует implementation. Node искать через shutil.which и явно skip при отсутствии: CLI не получает Node dependency.
- [x] Step 3: Запустить `python3 -m unittest discover -s plugins/figma-ops/tests -p test_mcp_recipes.py -v`; зафиксировать ожидаемый RED из-за отсутствующих recipes.
- [x] Step 4: Переписать skill и references по spec, добавить focused routing reference. Ориентир main skill ≤600 слов, детали в references; не ограничивать полноту ради счётчика слов.
- [x] Step 5: В routing reference дать runnable read-only recipes для identity/selection/ancestry и bounded raw subtree/prototype. Defaults: maxNodes=200, maxDepth=4, maxBytes=32768; явный requested root. При cap partial/frontier; не срезать внутри raw action. При недоступной lazy subtree отметить partial, не делать loadAllPagesAsync. Не сериализовать весь SceneNode через JSON.stringify, брать явные нужные поля.
- [x] Step 6: Сохранить geometry/QR/transparency, source/root, comments threads, bindings ID/mode semantics. Разделить new MCP workflow от неизменного CLI dossier, и live snapshot от REST version. Учесть разные server prefixes, exact-file routing, отсутствие selection и все prerequisites.
- [x] Step 7: Повторить focused recipe tests до PASS. Прочитать собственный diff, проверить ссылки внутри canonical root. Packaging пока может закономерно расходиться с legacy — его синхронизация принадлежит Task 2.
- [x] Step 8: Записать report с RED/GREEN командой/выводом, files, self-review и concerns в путь brief; вернуть короткий статус без commits. Controller выполнит task review до Task 2.

### Task 2: Упаковка, совместимость и verification report

**Files:**
- Modify: `plugins/figma-ops/README.md`, `plugins/figma-lookup/README.md`
- Modify: `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`
- Modify: `plugins/{figma-ops,figma-lookup}/{.claude-plugin,.codex-plugin}/plugin.json`
- Modify: `plugins/figma-ops/tests/test_packaging.py`
- Generate: `plugins/figma-lookup/skills/figma-lookup/SKILL.md` и `references/*.md` через существующий sync.
- Create: `docs/superpowers/research/2026-10-26-figma-ops-mcp-routing-verification.md`

**Interfaces:**
- Consumes: reviewed canonical skill/references и recipes tests Task 1; controller передаёт пути baseline/application/live evidence.
- Produces: оба автономных plugin root, canonical 1.3.0 / alias 1.4.0, согласованные catalogs/manifests и честный verification report.

- [x] Step 1: Обновить expected versions/reference set в existing packaging tests для двух hosts; reference set теперь содержит семь файлов включая mcp-routing.md. Не добавлять тесты на дословное совпадение всего prose.
- [x] Step 2: Запустить `python3 -m unittest discover -s plugins/figma-ops/tests -p test_packaging.py -v`; зафиксировать ожидаемые FAIL по versions/reference copy до упаковки.
- [x] Step 3: Обновить README обоих plugins, descriptions и versions четырёх manifests/двух marketplace entries. Codex catalog расположен в `.agents/plugins/marketplace.json`. Изменять только Figma entries, сохранить остальные plugins.
- [x] Step 4: Выполнить `python3 plugins/figma-ops/scripts/sync-compat.py`; runtime 15 modules должны остаться byte-identical к HEAD и между roots. Maintenance script не копируется в legacy.
- [x] Step 5: Запустить весь `python3 -m unittest discover -s plugins/figma-ops/tests -v` один раз: прежние 282 tests и новые recipes; packaging доказывает оба hosts, refs, idempotence и 22 base operations/24 help calls/12 extra cases в двух isolated roots. Новые failures локализовать focused command, не повторять весь suite без причины.
- [x] Step 6: Записать verification report: synthetic tests отдельно от live status/targeted read/export; application scenarios отдельно от реального host activation. Если fresh child inference недоступен по прежнему policy, не повторять его другим способом и не называть ручное чтение host GREEN. Не публиковать private IDs/texts/values; подстановка synthetic данных не считается live успехом.
- [x] Step 7: Проверить JSON parsing, internal links, `git diff --check`, неизменность runtime/auth и границы scope. Зафиксировать, что CLI команды не удалены и автоматически не переключились на MCP.
- [x] Step 8: Записать report implementer и вернуть короткий статус. Controller выполнит task review, затем whole-branch review против spec, не только plan; важные findings исправит отдельный worker.

## Controller verification и завершение

- До Task 1 сохранить отдельно held-out сценарии и baseline старой версии. Новый application evaluator читает актуальные файлы явно; результат не считается активацией skill в свежем host.
- После Task 1 проверить актуальные recipes на разрешённом файле read-only при доступном Bridge, без whole-file scan и без private данных в tracked report. Проверить точный export при достаточных доступных tools; если доказательств нет — обозначить ограничение.
- При unavailable/empty данных не создавать макет ради проверки; synthetic tests покрывают соответствующие branches.
- После Task 2 проверить all-spec acceptance matrix, заказать independent whole-branch review со scoped working-tree diff и evidence. Не запускать tests повторно без новых изменений/сомнений.
- Финал: перечислить изменение, результаты и material limitations; сохранить worktree/ветку. Установленные plugins обновляются после merge, PR сейчас не открывается без поручения.
