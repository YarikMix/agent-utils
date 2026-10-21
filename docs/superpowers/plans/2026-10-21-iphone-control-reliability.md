# Надёжность iphone-control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Передать подтверждённые приёмы владения телефоном, восстановления, ввода и проверки результата в существующий навык.

**Architecture:** Документационный плагин сохраняет краткий SKILL и использует operations/recovery/validation references. Подготовленный до правок набор синтетических задач проверяет принятие решений свежими процессами на снимках OLD/NEW, без live iPhone.

**Tech Stack:** Markdown, JSON plugin manifests, свежий Codex CLI для reasoning-проверок, стандартная библиотека Python для статической валидации; без новых runtime-зависимостей.

**Spec:** `docs/superpowers/specs/2026-10-21-iphone-control-reliability-design.md`

## Global Constraints

- Сохраняем имя и trigger `iphone-control`, существующие native/context/geometry/privacy правила, ссылку на отдельный `setup-iphone-control`.
- Штатный путь остаётся MCP. Не обходить policy/permission rejection через WDA.
- Не менять setup-навык, MCP runtime и установленные копии `~/.codex/skills`/`~/.claude/skills`.
- В публичных файлах нет личных UDID, team/bundle IDs, исторических портов, путей пользователя, корпоративных URL, приватных XML/скриншотов или логов auth.
- Ночная работа не включает новый live iPhone-прогон.
- Обновляем `iphone-control` до 1.0.1 в обоих manifests и обеих marketplace-записях, не меняя версии/поля других плагинов.
- Не выдавать статические проверки за behavioral/live-проверку.

## Review Focus

- Worker без MCP: нельзя передавать ему владение телефоном по наличию tools у controller (сценарий H1).
- Code41 на чужой сессии или повтор после bounded retry: нельзя удалить сессию или менять безопасность (H2/H3).
- URL после успешного ввода не совпал: Return запрещён; неизвестный исход требует наблюдения (H4/H5).
- Два локальных endpoint, policy rejection, разные WDA/Appium IDs: диагностический маршрут требует доказательства владения и не расширяет права (H6/H7).
- Native карточка при прежнем foreground bundle: результат проверяется экраном/XML, а не bundle/hidden (H8).

## Структура файлов

`docs/superpowers/research/2026-10-21-iphone-control-cases.md` — неизменяемые held-out prompts и рубрика; `...-validation.md` — очищенный отчёт OLD/NEW. Сырые ответы, snapshot OLD/NEW и test runner находятся только в плановом gitignored workspace. Публичный training skill не содержит ответы/значения held-out prompts.

`plugins/iphone-control/skills/iphone-control/SKILL.md` — основной workflow. `references/operations.md` — наблюдение/ввод/результат. Новый `references/recovery.md` — bounded recovery и диагностика WDA. `references/validation.md` — проверенные границы и ссылка на отчёт. README и четыре JSON — только содержание плагина и его версия.

### Task 1: Зафиксировать отложенные сценарии и OLD baseline

**Files:** Create `docs/superpowers/research/2026-10-21-iphone-control-cases.md`; Create начальный `docs/superpowers/research/2026-10-21-iphone-control-validation.md`; scratch-файлы только в workspace этого плана.

**Interfaces:** Consumes: старый навык на base `83221b18479f05a5fc88aafb67da5601c382aec6`, спецификация R1–R6. Produces: восемь неизменяемых сценариев H1–H8 плюс два regression-контроля H9/H10, рубрика pass/fail/partial, OLD snapshot с SHA256, точная команда и все OLD ответы/оценки в scratch; очищенный baseline в отчёте.

- [ ] **Step 1: Подготовить prompts до изменения production-текста.** Десять отдельных задач: H1 нет tools у worker + конкурирующий controller; H2 чужая/неясная сессия; H3 собственная stale/повтор Code41; H4 дописанный URL при tool success; H5 неизвестный исход Return + нет безопасной очистки; H6 несколько локальных endpoint/ID без доказательства привязки; H7 явный policy rejection; H8 StoreKit поверх прежнего bundle; H9 WEBVIEW context/устаревшие IDs; H10 геометрия/подмена setup/cleanup. Каждая имеет наблюдения и практическую просьбу назвать следующий шаг, без готового решения в prompt. Зафиксировать утверждения рубрики заранее; запретить live actions.
- [ ] **Step 2: Снять OLD в отдельном свежем процессе на сценарий.** Claude CLI уже проверен controller: `Not logged in`, нулевые токены; не повторять login и не читать credentials. Использовать fresh Codex CLI согласно доступному help, snapshot всей инструкции и references вводить явно, stdin/file, без чтения installed skills или соседних worktree. Выход только решение по фиктивным наблюдениям, никаких tools; сохранить JSONL и последний ответ. Для каждого процесса убедиться, что assistant дал ответ и не совершал tool calls. Не наследовать контекст root, не использовать collaboration agents как GREEN subjects.
- [ ] **Step 3: Проверить baseline по рубрике вручную.** Сохранить N и каждое нарушение/цитату; ошибки инфраструктуры отдельно от FAIL. Если OLD в группе уже PASS, не приписывать будущей правке улучшение. Если новых пробелов нет, сообщить controller: не подгонять prompts после OLD.
- [ ] **Step 4: Зафиксировать fixtures и очищенный baseline.** `git diff --check`, проверить отсутствие личных данных и кодировочных артефактов. Не коммитить raw stdout с локальными путями/runtime/config. Коммит только двух research-файлов; отчёт исполнителя в workspace, со всеми командами и результатами.

### Task 2: Дополнить навык и упаковку

**Files:** Modify `plugins/iphone-control/skills/iphone-control/SKILL.md`, `references/operations.md`, `plugins/iphone-control/README.md`, оба `plugins/iphone-control/.{claude,codex}-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`; Create `plugins/iphone-control/skills/iphone-control/references/recovery.md`.

**Interfaces:** Consumes: неизменяемый OLD baseline Task 1, требования R1–R6 спецификации. Produces: NEW документация и четыре согласованные записи версии 1.0.1; `references/validation.md` ещё не объявляет новое успешным — окончательная validation в Task 3.

- [ ] **Step 1: Прочитать OLD нарушения и исходные rationale.** Новые рекомендации адресуют подтверждённые пробелы; R1–R6 сохраняют существующие границы даже если baseline уже корректен. Внешний WDA HTTP не превращать в штатный путь. Не читать held-out prompts как примеры для копирования в skill; достаточно baseline rubric/failure summaries и спецификации.
- [ ] **Step 2: Изменить основной workflow.** Краткий handoff-протокол R1, recovery pointer R2/R4, надёжный input/result pointer R3/R5. Не дублировать все API в SKILL. Триггер сохраняется, setup отдельно. Цена новых ограничений — больше наблюдений, а не новые разрешения.
- [ ] **Step 3: Описать операции и recovery.** Точный ввод с очисткой/проверкой до Return; без выдуманного clear MCP. Прямой WDA clear только после R4, реальные схемы не смешивать. Добавить StoreKit и уровни доказательств. Recovery включает собственность, один bounded retry, повтор Code41, подтверждение endpoint/device/session и finite timeout, loopback proxy opt-out, запрет обхода policy.
- [ ] **Step 4: Обновить README и версии до 1.0.1.** Изменить только iphone-control entries; сохранить прочие JSON-поля/формат. Не ставить обновление локально, не менять setup и чужие плагины.
- [ ] **Step 5: Выполнить статическую проверку.** Стандартным Python: JSON 4/4, версия 1.0.1 в двух manifests и двух нужных entries; все локальные markdown links существуют; required name/description не меняют trigger; публичный diff без личных данных; `git diff --check`. Отдельно сравнить остальные marketplace entries с HEAD до задачи. Полный список команд/вывод в отчёт. Не заменять этим GREEN behavioral.
- [ ] **Step 6: Коммит только перечисленных файлов.** `docs: make iphone-control handoff and recovery reliable`. Отчёт с self-review и ограничениями.

### Task 3: NEW проверка, регрессия и окончательная validation

**Files:** Modify `plugins/iphone-control/skills/iphone-control/references/validation.md`, `docs/superpowers/research/2026-10-21-iphone-control-validation.md`; scratch NEW outputs только в workspace. При выявленном дефекте controller назначает scoped fix навыка через исполнителя, не замазывает результат.

**Interfaces:** Consumes: prompts/rubric/runner OLD из Task 1 неизменёнными, NEW body из Task 2. Produces: сравнение OLD/NEW по десяти сценариям, SHA256 и воспроизводимые команды, ограничения runtime/discovery/live, актуальная ссылка в skill validation.

- [ ] **Step 1: Сделать NEW snapshot и свежие процессы.** Тот же runtime/model и одинаковые flags/prompts, меняется только snapshot. Проверить отсутствие device/tools actions и контекстной утечки. Не выдавать synthetic-ответ за проверку живого MCP.
- [ ] **Step 2: Оценить все ответы по ранее зафиксированной рубрике.** Требуется отсутствие небезопасных решений и PASS regression H9/H10. Частичный/неоднозначный ответ помечать partial; новые реальные нарушения отправить controller с точной цитатой и кратким исправлением. Не менять тест ради PASS и не повторять успешные сценарии без причины. Для проблемной формулировки reference допускает focused fresh rerun с указанным основанием; первичный результат сохраняется.
- [ ] **Step 3: Обновить validation и очищенный отчёт.** Таблица каждого кейса с N, OLD/NEW, краткая цитата/вывод, точные команды воспроизведения, snapshots/модель; недостаток Claude auth, отсутствие client discovery/live и различающего эффекта там, где обе версии PASS, явно. Существующие факты живого прогона 19.10 сохранить; добавить обобщённые наблюдения текущей сессии без приватных деталей и новых гарантий.
- [ ] **Step 4: Финальная статическая проверка и коммит.** JSON/version/link/privacy/diff checks как Task 2 на финальном дереве. Указания validation должны соответствовать реально сохранённому отчёту. `git diff --check`; commit только двух validation-файлов (и отдельно назначенных controller scoped fixes, если были).

## Самопроверка плана

R1–R5 покрыты Task 2 и H1–H10; R6 — Task 2 и финальные проверки Task 3. Baseline до production-правок Task 1. Task 3 использует исходные fixtures, не их пересказ. Схемы native/context/geometry остаются и проверяются H9/H10. Нет нового executable runtime/helper, новый standalone test framework не требуется. Время и телефон не являются зависимостями. На каждой задаче независимое spec+quality review, затем whole-branch review по исходной спецификации; commit/push/PR явно поручены пользователем, merge не поручен.
