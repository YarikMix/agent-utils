# Figma Ops

Read-only работа с Figma для Claude Code и Codex: поиск экранов и текста,
предки нод, annotations, prototype actions, context dossier, полные обсуждения
и проверенный экспорт. Версия 1.1.0 добавляет три команды к прежним семи. Плагин добавляет skill
и автономный REST CLI; Figma MCP подключается отдельно.

## Установка

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install figma-ops@yarikmix-plugins

codex plugin marketplace add YarikMix/agent-utils
codex plugin add figma-ops@yarikmix-plugins
```

Skill [figma-ops](skills/figma-ops/SKILL.md) доступен по имени плагина/скилла
и автоматически для подходящих задач. Manifests обоих хостов указывают
`./skills/`. `figma-lookup` 1.2.0 сохраняет прежнее имя и тот же workflow;
для новой установки достаточно одного из имён. Каждый plugin root автономен.

## Маршруты

- MCP metadata/screenshot — обычное чтение; `get_design_context` — реализация
  после загрузки официального `figma-design-to-code`.
- Полные комментарии и экспорт — доступный MCP либо настроенный REST CLI.
- Dossier — настроенный REST `context` точного source, затем явный
  `--scope-root`/screenshot при необходимости, annotations/prototype и threads.
  Расширение охвата сохраняет source; `--node` переопределяет сам source.
- Prototype actions — REST `prototype` с явными follow/budgets либо read-only
  `use_figma` после официального `figma-use` перед каждым вызовом.
- Keyframes/timeline — отдельный `get_motion_context` нужного source/destination;
  motion через `use_figma` требует также `figma-use-motion`. MCP evidence artifacts
  сохраняются отдельно рядом со ссылкой на REST dossier.
- UI через опциональный `peekaboo-control` — для недоступного другим путём
  действия или контекста канваса. Автоматическая установка не требуется.

Токен необязателен для MCP. REST использует только уже заданный `FIGMA_TOKEN`
или существующий macOS Keychain service `figma-rest`, account `figma`.
Не требуется искать или читать `.env`/конфиги. Токен передаётся curl через
stdin и не передаётся asset hosts. Настройка credentials не запускается,
если MCP достаточно. Подробнее: [auth](skills/figma-ops/references/auth.md).

## CLI

Python 3.10+ и системный `curl`, без pip/npm или нового MCP-сервера.
Укажи абсолютный путь **установленного** плагина; cwd может быть любым:

```sh
FIGMA_OPS_CLI='/absolute/path/to/installed/plugin/scripts/figma_ops.py'
python3 "$FIGMA_OPS_CLI" --help
python3 "$FIGMA_OPS_CLI" inspect SyntheticKey --node '1:2' --depth 1
python3 "$FIGMA_OPS_CLI" context DemoFile --node '31:8' --scope-root '31:4' --output '/tmp/figma dossier.json'
python3 "$FIGMA_OPS_CLI" annotations DemoFile --node '31:4' --query 'Отступ'
python3 "$FIGMA_OPS_CLI" prototype DemoFile --node '31:4' --follow 1 --max-frames 6
python3 "$FIGMA_OPS_CLI" search SyntheticKey --query 'Повторить' --node '1:2' --output '/tmp/figma matches.json'
python3 "$FIGMA_OPS_CLI" comments SyntheticKey --query 'Повторить' --status all
python3 "$FIGMA_OPS_CLI" thread SyntheticKey --comment 'example-reply-id' --refresh
python3 "$FIGMA_OPS_CLI" export SyntheticKey --node '1:2' --format png --scale 2 --dest '/tmp/figma assets'
python3 "$FIGMA_OPS_CLI" fills SyntheticKey --node '1:2' --dest '/tmp/figma sources'
```

TARGET — file key или HTTPS URL design/file/proto (branch key сохраняется).
Общие флаги после подкоманды: `--refresh`, `--no-cache`, `--cache-dir`,
`--output`. JSON schema_version 1; status ok/partial/error и coverage/warnings.
Exit 0 — ok/partial, 1 — ошибка операции, 2 — аргументы. `--output` сохраняет
полный собранный envelope и печатает путь/размер; снимает inline limits списков,
сохраняя сетевые budgets. Новые команды требуют node из URL или `--node`.
Timeout 35 секунд, кэш 300 секунд; HTTP 429 отдаёт retry_after без sleep.
`doctor` проверяет только `/me`, а не scopes всех endpoint.

Пустой search означает только отсутствие совпадений в загруженном охвате.
Фильтры comments работают по всей ветке и сохраняют replies; pin scope
учитывает точную ноду и её потомков, не соседние frames. PNG прозрачность
проверяется по декодированным пикселям; scale=2 не доказывает реальный 2×.
Export не меняет макет и не перезаписывает файлы без `--overwrite`.
Все десять операций read-only; отправка комментариев, Resolve
и изменения дизайна не входят в них.

Annotations — отдельные от comments данные нод. Missing поля не равны пустым
массивам; неполный dossier не доказывает отсутствие кейса. Prototype сохраняет
весь порядок actions/raw easing и времени; без калибровки `verified_unit` и
`normalized_ms` null, даже если документация называет единицу. Follow выполняет
ограниченный BFS; неуспешные новые roots расходуют `--max-frames`, partial
сохраняет frontier/reasons и exit0. `--output` не расширяет сетевой budget.

Context различает source/root, sections и independent-requests snapshot;
comments version null, полные replies сохраняются. Motion и canvas visual
CLI не собирает: `not_collected` не означает недоступность MCP/отсутствие motion.
Без token/tools продолжай доступные чтения и отмечай конкретные пробелы.

Подробности: [reading](skills/figma-ops/references/reading.md),
[comments](skills/figma-ops/references/comments.md),
[assets](skills/figma-ops/references/assets.md),
[context](skills/figma-ops/references/context.md).

## Разработка и совместимость

Канонический код и skill находятся в этом плагине. В репозитории после
изменений выполни:

```sh
python3 plugins/figma-ops/scripts/sync-compat.py
python3 -m unittest discover -s plugins/figma-ops/tests -v
```

`sync-compat.py` — инструмент сопровождения репозитория: копирует runtime
`.py`, references и тело skill в соседний `figma-lookup`, меняет только
frontmatter имени/совместимости. Tests и сам sync tool не копируются.
Установленный CLI не вызывает sync и не зависит от соседнего plugin root.
Packaging tests проверяют оба marketplace/manifests, локальные references,
точность копий и все 10 операций/11 help calls в каждом из двух отдельных
установленных roots из cwd с пробелами: 20 операций, 22 help calls и partial cases.
Это файловые и synthetic transport проверки; они не заменяют проверку
реального discovery в Claude Code/Codex или живого Figma API.
Sanitized результаты и ограничения второй итерации —
[verification report](../../docs/superpowers/research/2026-10-23-figma-ops-iteration-2-verification.md).
