# Figma Lookup — совместимое имя Figma Ops

Версия 1.3.0 сохраняет установку и вызов `figma-lookup` с workflow
Figma Ops 1.2.0: чтение через MCP, автономные REST context/annotations/prototype,
scoped design-system bindings, поиск/обсуждения/экспорт
и UI fallback. Каждый plugin root содержит собственный runtime, skill
и references; установка соседнего `figma-ops` не требуется.

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install figma-lookup@yarikmix-plugins

codex plugin marketplace add YarikMix/agent-utils
codex plugin add figma-lookup@yarikmix-plugins
```

Начни с [skill](skills/figma-lookup/SKILL.md).
Для нового пользователя основное имя — `figma-ops`; достаточно одного из имён.
Существующий `figma-lookup` продолжает обнаруживаться обоими клиентами через
`./skills/`. Тело инструкции, references и runtime генерируются из канонического
Figma Ops; не редактируй копии вручную.

Python 3.10+ и системный curl; без pip/npm. CLI запускается из любого cwd:

```sh
FIGMA_OPS_CLI='/absolute/path/to/installed/plugin/scripts/figma_ops.py'
python3 "$FIGMA_OPS_CLI" --help
python3 "$FIGMA_OPS_CLI" context DemoFile --node '31:8' --scope-root '31:4' --output '/tmp/figma dossier.json'
python3 "$FIGMA_OPS_CLI" bindings SyntheticKey --node '1:2'
python3 "$FIGMA_OPS_CLI" context SyntheticKey --node '1:2' --with-bindings --with-variables
python3 "$FIGMA_OPS_CLI" comments SyntheticKey --query 'Повторить' --status all
python3 "$FIGMA_OPS_CLI" export SyntheticKey --node '1:2' --scale 2 --dest '/tmp/figma assets'
```

MCP подключается отдельно и не требует REST-токена. Для REST доступны только
уже заданный `FIGMA_TOKEN` или существующий macOS Keychain service `figma-rest`,
account `figma`; `.env` и конфиги не читаются. Все одиннадцать операций read-only:
полные комментарии/replies, ancestry, поиск текста/имён, проверка скачанных
assets. Пустые metadata не доказывают отсутствия сценария, scale=2 не доказывает
размер 2×, alpha-канал не доказывает прозрачность. Нет автоматической отправки
комментариев, Resolve или изменения дизайна.

Workflow: context точного source → явный root/screenshot при необходимости →
annotations/prototype и threads → отдельный `get_motion_context` нужного
source/destination, MCP evidence artifacts рядом со ссылкой на dossier.
Перед каждым `use_figma` — `figma-use`, motion через него также требует
`figma-use-motion`; `get_design_context` — для реализации после
`figma-design-to-code`. Схемы инструментов проверяются при запуске.
REST transitions не заменяют keyframes; единицы raw времени не угадываются.
Missing поля не равны пустым массивам. Partial сохраняет доступные данные и
frontier; CLI `not_collected` не доказывает недоступность host API. Без token/tools
продолжай доступную часть, указывая непроверенные секции.

Bindings собирает только использованные components/styles/variable refs точного
subtree за один source GET; `--with-variables` добавляет один file-wide metadata
GET (`file_variables:read`, Enterprise/full membership). Optional 403 сохраняет
полезный partial; причина отказа остаётся неизвестной. Context `--with-bindings`
переиспользует source, comments идут отдельно; `--without-comments` подходит для
content-only доступа. Default context сохраняет шесть sections/две hints.
Aliases/modes arrays/SLOT сохраняются raw; effective values не вычисляются.
Отдельное MCP `get_variable_defs` требует discovery текущего хоста и evidence
без угаданного REST ID mapping; Code Connect только read-only.

Детали: [auth](skills/figma-lookup/references/auth.md),
[reading](skills/figma-lookup/references/reading.md),
[comments](skills/figma-lookup/references/comments.md),
[assets](skills/figma-lookup/references/assets.md),
[context](skills/figma-lookup/references/context.md),
[bindings](skills/figma-lookup/references/bindings.md).

Для сопровождения используй `plugins/figma-ops/scripts/sync-compat.py`
в исходном репозитории. Сам установленный плагин этот скрипт не требует.
Packaging tests сравнивают копии побайтово и проверяют автономный запуск
обоих имён с synthetic transport (11 операций и 12 help calls на root, плюс
6 дополнительных enrichment/partial/context cases на root); реальный host discovery проверяется отдельно.
