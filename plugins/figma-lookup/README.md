# Figma Lookup — совместимое имя Figma Ops

Версия 1.4.0 сохраняет установку и вызов `figma-lookup` с workflow
Figma Ops 1.3.0: targeted Southleft Bridge для обычного live чтения,
официальный Figma MCP для design-to-code/Code Connect/motion и автономный
REST CLI для headless, dossier и полных обсуждений. Каждый plugin root содержит собственный runtime, skill
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

MCP-серверы подключаются отдельно: manifests их не устанавливают.
Сначала discovery реальных capabilities и schemas; для Southleft — active
status probe и список подключённых файлов. Targeted execute получает точный
file/branch key и проверяет `figma.fileKey` до чтения. Другой active file не
подменяет target; selection читается заново в подтверждённом файле, пустое
выделение не разрешает whole-file scan. Source и scope-root сохраняются отдельно.

Southleft подходит для bounded subtree/ancestry/text/geometry/annotations,
raw reactions и bindings/definitions с явными node/depth/byte budgets и frontier.
Перед `get_design_context` нужен `figma-design-to-code`; Code Connect — через
официальные read-only mapping tools. Keyframes — отдельный `get_motion_context`:
REST/Bridge transitions не доказывают timeline. Соблюдай текущие
`create_session`/`sessionId`; перед каждым `use_figma` — `figma-use`, для motion
через него также `figma-use-motion`. API existence не доказывает чтение tracks.

Preview/screenshot помогает увидеть ноду, но не заменяет точный export.
MCP export либо CLI `export`/`fills` требует скачанного проверенного файла:
scale=2 не доказывает размер 2×, alpha-канал не доказывает прозрачность.
Полные comments/threads читаются CLI с существующим auth; Southleft допустим
при работающем PAT, `include_resolved=true` и сохранении root/replies/pins.
Annotations — другой вид данных. Нет изменений дизайна, comments, mappings,
selection/page или импорта library entities ради чтения.

Для REST доступны уже заданный `FIGMA_TOKEN` или существующий macOS Keychain
service `figma-rest`, account `figma`; `.env` и конфиги не читаются.
Southleft `FIGMA_ACCESS_TOKEN` — отдельный контракт, автоматического переноса
credentials и настройки comments нет. Если Bridge достаточно, PAT не нужен.
Подробнее: [auth](skills/figma-lookup/references/auth.md).

Offline/missing tools или неподключённый target допускают другой разрешённый
маршрут с явными пробелами. Policy/organization denial и 429 нельзя обходить
другим транспортом/credentials; сохрани `retry_after` и доступное evidence.
Тарифный Variables REST 403 сам по себе не запрещает независимый предусмотренный
Plugin API read. Missing поля не равны пустым массивам, partial не означает
отсутствие кейса. CLI `not_collected` не доказывает недоступность host API.

Все 11 read-only CLI operations, envelopes и headless режим сохранены и не
переключаются на MCP автоматически. MCP artifacts и REST dossier сохраняются
отдельно: file/branch, source/root, фактический tool/transport, время, coverage;
общая document version не выдумывается. Подробный маршрут и recipes —
[MCP routing](skills/figma-lookup/references/mcp-routing.md).

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
Sanitized проверки и ограничения — [verification report](../../docs/superpowers/research/2026-10-26-figma-ops-mcp-routing-verification.md).
