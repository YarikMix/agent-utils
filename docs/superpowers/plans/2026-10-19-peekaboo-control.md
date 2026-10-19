# Peekaboo Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Опубликовать переносимый навык управления macOS через Peekaboo MCP → Desktop Bridge с дополнительным CLI и установить его в Codex.

**Architecture:** Документационный плагин поверх установленного Peekaboo, без собственного runtime. Короткий вход направляет к четырём справкам; MCP и CLI используют явно выбранный Desktop Bridge. Установка недостающих компонентов требует согласия пользователя.

**Tech Stack:** Markdown, YAML frontmatter, JSON plugin manifests; Peekaboo Desktop/CLI/MCP, Codex и Claude Code.

**Spec:** [2026-10-19-peekaboo-control-design.md](../specs/2026-10-19-peekaboo-control-design.md). Исполнители и ревьюеры читают и спеку, и план.

## Global Constraints

- Основной путь: Peekaboo MCP → Desktop Bridge; CLI дополняет отсутствующие операции и диагностику, не обходит отказы MCP.
- Плагин `peekaboo-control`, версия `1.0.0`, `skills: ./skills/`, публичный `YarikMix/agent-utils`, Codex и Claude Code.
- Установка документационного плагина не подключает MCP.
- На готовом Mac не начинать с переустановки; на другом Mac спрашивать разрешение только на недостающие компоненты, учитывая авторизацию текущей сессии.
- Системные разрешения подтверждает человек; foreground и temporary clipboard — отдельные grants, не включать незаметно.
- Не создавать собственный CLI, MCP-сервер или фоновый сервис; не ослаблять TLS, подпись или macOS security.
- Локальные пути определять на Mac; сохранять комментарии и соседние записи конфигов; не публиковать приватные данные.
- Триггер `Use when`, тело по-русски, `SKILL.md` — цель до 500 слов. Версии 4.9.0/4.9.5 не объявлять минимальными; число tools не фиксировать.
- GUI проверяет один агент; предупредить о своём окне, закрыть только его, сохранить чужую работу.
- Изолированная площадка уже есть: linked worktree `agent-utils-github-iphone-appium`, исходный HEAD и свежий origin/main `d9258951e3faa7b4246580c306c53f99cf330fda`. Основной checkout не менять.
- Исполнение — ранее выбранный subagent-driven-development. Во время SDD не коммитить промежуточные задачи; итоговый коммит после ревью и проверок. Чужие изменения сохранять.

## Review Focus

1. Все TCC права есть, MCP запрещает foreground: агент объясняет grant, не обходит запрет CLI (Task 1, сценарий C).
2. MCP не виден в сессии при существующем конфиге: проверить runtime/restart, не переустанавливать всё (Task 1, сценарий G).
3. После клика timeout и экран изменился: сначала наблюдение; не повторять клик по старому ID (Task 1, сценарий E).
4. Есть только часть компонентов: конкретный список и согласие до установки, сохранение конфига (Task 1, сценарий B).
5. CLI и Desktop разных версий: обнаруживать фактический host и актуальный leaf help, не фиксировать число tools (Task 1, сценарии A/D).

---

### Task 1: Рабочий навык и переносимая настройка

**Files — create:**
- `plugins/peekaboo-control/skills/peekaboo-control/SKILL.md`
- `plugins/peekaboo-control/skills/peekaboo-control/references/operations.md`
- `plugins/peekaboo-control/skills/peekaboo-control/references/setup.md`
- `plugins/peekaboo-control/skills/peekaboo-control/references/troubleshooting.md`
- `plugins/peekaboo-control/skills/peekaboo-control/references/validation.md`

**Interfaces:** consumes согласованную спеку, реальные MCP schemas/CLI help и официальные инструкции. Produces единственный вход `peekaboo-control` и четыре относительные ссылки `references/{operations,setup,troubleshooting,validation}.md`. Подробные схемы инструментов не копировать целиком; показать выбор по задаче и способ найти актуальные параметры.

- [ ] **Step 1: Подготовить отложенные проверки до текста скилла.** В приватном временном каталоге сохранить семь независимых запросов с вымышленными именами приложений/данными и ожидаемыми решениями. A: готовый Bridge, версии CLI/Desktop различаются → reuse, MCP first. B: Desktop отсутствует, CLI есть → запрос только недостающего, без преждевременной установки. C: все TCC true, policy foreground denied → запрос конкретного grant, без CLI обхода. D: нужна CLI-only read-only операция → актуальный leaf help, явный Bridge, проверка вывода. E: timeout клика и изменившийся экран → новое наблюдение, без слепого повтора. F: stale snapshot/opaque ID и большая decimal process identity → свежая цель, ID не преобразовывать, identity строкой. G: конфиг есть, tools текущей сессии отсутствуют → диагностика процесса/перезапуска, без переустановки. Не включать эти запросы и ответы примерами в скилл.
- [ ] **Step 2: Снять baseline без скилла.** По одному свежему процессу `claude -p` на запрос, только чтение из изолированного каталога и предоставленных фикстур; реальные GUI, сеть, запись конфигов и установка запрещены. Сохранить точную команду, видимые инструкции, ответы и оценку каждого A–G. Проверить доступные флаги через `claude --help`; не подменять HOME/CODEX_HOME и не менять рабочие глобальные скиллы. Реальное решение задачи отделить от пересказа запроса. Нужен наблюдённый пробел baseline перед написанием направленного на него текста; если пробела нет во всех сценариях, зафиксировать это и уточнить проверочную задачу, не заявлять улучшение.
- [ ] **Step 3: Создать навык по ответственности файлов из спеки.** `operations`: карта задач MCP/CLI, opaque IDs, координаты, ожидания, process identity, clipboard и устаревшие CLI команды. `setup`: обе платформы клиентов, официальная установка недостающего, явный socket, точечный конфиг и restart. `troubleshooting`: transport/host/TCC/policy/sandbox и неизвестные исходы. `validation`: безопасная приёмка, восстановление, ограничения доказательств. Ссылки на первичные источники держать рядом с изменяемыми сведениями.
- [ ] **Step 4: Проверить примеры по живому интерфейсу.** Прочитать актуальные schemas доступных MCP tools; для каждой CLI команды в справках выполнить leaf `--help`. Read-only `bridge status` и `permissions status` проверить с явно выбранным socket. Не считать sandbox denial подтверждением TCC failure; при необходимости адресное escalation только для разрешённой диагностики. Непроверенные действия явно пометить, живые mutation-команды отложить до Task 3.
- [ ] **Step 5: Повторить A–G с новым навыком.** Использовать отдельные свежие процессы с поддерживаемым механизмом загрузки локального скилла, проверенным по help клиента. Дать чтение только нужного дерева/фикстур; не давать живые инструменты записи. В trace проверить фактически прочитанный новый `SKILL.md`, а не кэш текущей сессии. Все семь решений должны соответствовать assertions Step 1. Сравнить baseline и новую версию на том же отложенном наборе; исправить реальные ошибки и повторить затронутые сценарии свежими процессами.
- [ ] **Step 6: Валидировать и отдать task reviewer.** Run: `python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/peekaboo-control/skills/peekaboo-control`. Expected: skill valid. Проверить относительные ссылки и размер входа. Независимый ревьюер сверяет весь Task 1 со спекой; исправить существенные замечания до Task 2. Приватные eval traces в git не добавлять.

### Task 2: Упаковка для Codex и Claude Code

**Files — create:**
- `plugins/peekaboo-control/.claude-plugin/plugin.json`
- `plugins/peekaboo-control/.codex-plugin/plugin.json`
- `plugins/peekaboo-control/README.md`
- `plugins/peekaboo-control/LICENSE`

**Files — modify:** `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `README.md`.

**Interfaces:** consumes дерево скилла из Task 1. Produces installable docs-only plugin `peekaboo-control@yarikmix-plugins`, без auto MCP configuration. Claude source `./plugins/peekaboo-control`; Codex source `{source:local,path:./plugins/peekaboo-control}`.

- [ ] **Step 1: Создать manifests по соседнему iphone-control.** Имя/версия/skills из Global Constraints, MIT, автор Yaroslav Mihalev. Codex interface: `displayName: Peekaboo Control`, короткое описание управления macOS. Никаких `mcpServers` или installer hooks. LICENSE скопировать из соседнего MIT плагина.
- [ ] **Step 2: Добавить по одной записи каталогов и документацию.** Claude category `productivity`; Codex `Productivity`, policy `installation: AVAILABLE`, `authentication: ON_INSTALL`. В README команды `claude plugin install peekaboo-control@yarikmix-plugins` и `codex plugin add peekaboo-control@yarikmix-plugins` после добавления marketplace `YarikMix/agent-utils`; пояснить отдельное подключение MCP и запрос согласия на недостающие компоненты.
- [ ] **Step 3: Проверить контракт упаковки и task review.** Загрузить оба manifests/marketplaces JSON-парсером; assert name/version/skills/source, ровно одна новая запись в каждом каталоге, прежние записи структурно равны исходным. Проверить существование skills/paths и локальных Markdown ссылок; `git diff --check` без ошибок. Свежий ревьюер сверяет со спекой и проверяет отсутствие автоматической настройки MCP.

### Task 3: Живая приёмка, публикация и установка

**Files — create:** `docs/peekaboo-control-verification.md`.
**Files — modify only if checks find defects:** файлы Tasks 1–2.

**Interfaces:** consumes готовый плагин и текущее настроенное окружение. Produces публичный обезличенный отчёт, опубликованный SHA и одну user-level установку `peekaboo-control` в Codex. Временные GUI/eval/config артефакты остаются вне репозитория.

- [ ] **Step 1: Установить безопасную цель проверки.** Прочитать применимые инструкции computer-use; предупредить пользователя о новом тестовом окне. Выбрать/создать собственное временное приложение с полем и прокруткой, записать идентичность своего окна и исходное состояние. Не использовать открытые документы пользователя. Подготовка окна не должна скрытно менять grants MCP.
- [ ] **Step 2: Выполнить приёмку через фактический MCP.** Подтвердить явное подключение к Desktop Bridge и права. Через актуальные tools: see/inspect → targeted click → проверка; ввод уникальной строки → проверка значения; scroll → проверка видимой области. При policy denial не применять CLI для этого действия; отметить блокер и при необходимости запросить конкретный grant. Если grant не дан, разделить «проверено» и «заблокировано», не объявлять полную приёмку успешной.
- [ ] **Step 3: Проверить дополнительный CLI и cleanup.** Выполнить минимум одну дополнительную read-only операцию, например актуальный `bridge status`, через тот же socket. Все публикуемые mutation-примеры испытать на собственном окне с разрешёнными grants либо явно обозначить непроверенными и не выдавать за готовый рецепт. Закрыть только своё окно, удалить свои данные, корректно восстановить clipboard, если использовался; не затирать новые данные пользователя.
- [ ] **Step 4: Составить публичный отчёт и провести финальное ревью.** Указать версии, операции/результаты, baseline/новая версия, ограничения второго Mac/Claude, без приватных путей и сырых traces. Повторить validator, JSON/link проверки и `git diff --check`; проверить diff на личные/корпоративные сведения. Свежий whole-change reviewer сверяет все требования спеки, отчёт и реальные доказательства. Исправления требуют соответствующей повторной проверки; не подменять live evidence чтением help.
- [ ] **Step 5: Опубликовать.** Перед итоговым коммитом проверить scope diff; включить только файлы этой задачи и design/plan. Fetch свежего origin/main; при параллельных изменениях интегрировать их без перезаписи и перепроверить затронутые manifests. Обычный fast-forward push в main, без force. Проверить GitHub API: опубликованный SHA и содержимое всех файлов задачи совпадают с локальными, число проверенных файлов указать явно.
- [ ] **Step 6: Установить в Codex из опубликованного SHA.** Прочитать `skill-installer`; проверить отсутствие существующего standalone/plugin дубликата. Run official `install-skill-from-github.py --repo YarikMix/agent-utils --ref <SHA> --path plugins/peekaboo-control/skills/peekaboo-control --method git` через python3. Не отключать TLS. Через собственный свежий `codex app-server --listen stdio://` выполнить initialize/initialized и `skills/list` с `forceReload: true`; assert ровно один нужный навык, `enabled: true`, правильный путь/scope. Завершить только свой процесс. В финале дать ссылку на плагин, результат живой проверки и оставшиеся ограничения; сообщить о перезапуске текущей сессии, если нужен.

## Self-review

Спека покрыта: операционная модель и first-run — Task 1; manifests/каталоги — Task 2; фактический host, GUI, CLI, отчёт, publication/install — Task 3. Review Focus закреплён в A–G. Runtime interfaces не добавляются. Общий тестовый набор не гоняется: меняется только документационный плагин, его упаковка проверяется адресно. Перед реализацией требуется review плана пользователем; выбранный метод исполнения сохраняется.
