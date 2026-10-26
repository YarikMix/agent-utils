# Figma Ops native PNG assets: проверка

Дата: 26 октября 2026. Версии: figma-ops 1.4.0 / figma-lookup 1.5.0.

## Что поставляется

Два автономных plugin roots для Claude Code/Codex содержат по 16 одинаковых
runtime modules и 8 references. Новый `figma_asset_verify.py` — отдельный
локальный PNG entrypoint на Python 3.10+ stdlib. Старые 11 CLI operations,
REST dispatcher, auth, HTTP и decoder сохранены. Node используется только
в test harness для исполнения настоящих JS blocks из документации;
installed helper не требует Node, PAT, curl, Desktop или MCP.

Workflow: guarded exact-node native capture → exclusive host save → offline
pixels/alpha verify. Native capture и локальный receipt сохраняются отдельно.

## Синтетические проверки

Packaging RED выполнен до bump/sync: ожидаемо не совпали версии, runtime копии,
отсутствовали alias helper и native-assets reference. Штатный sync копирует
новый helper, skill и references; maintenance tool и test harness не копируются.

Новые standalone subprocess cases проверяют оба изолированных roots без sibling
из cwd с пробелами: transparent 1×1 PNG с парой размеров и прозрачностью
(exit0/local-file), opaque + transparency (exit1/asset_mismatch), один dimension
flag (exit2/invalid_argument). Суммарно 6 helper cases и 2 helper help calls;
они считаются отдельно от прежних 22 base operations, 24 CLI help calls и
12 enrichment/partial/context cases. Input hashes и содержимое временного
каталога остаются прежними; response cache не получает новых/изменённых entries,
fake curl/security log пуст, Figma token variables пусты. HOME/CODEX_HOME
не подменяются.

Focused helper tests отдельно проверяют bounded input/read failures, invalid
PNG, dimensions, прозрачные/opaque/unknown pixels, strict JSON и отсутствие
credential/network/cache/file-write side effects. Native tests исполняют
actual fenced capture/save recipes, включая fileKey guard до lookup, composite
ID, SCALE и payload cap, partial/error и сохранение existing destination.
M1 regression для existing bounded subtree подтверждает unavailable field
при throwing getter и сохранение соседних доступных значений/child.

Полный suite после интеграции запущен один раз:

```sh
python3 -m unittest discover -s plugins/figma-ops/tests -v
```

Результат: `Ran 319 tests in 9.946s`, `OK`, без skipped. Это прежние 296 tests
и 23 новых: 11 helper, 10 native capture/save, M1 и один packaging test.
Node recipes фактически исполнились. Packaging link resolution и двукратная
sync reproducibility прошли в этом suite. Отдельно подтверждены 16 runtime
pairs byte-identical, 8 references на root, прежние 30 runtime files и sync
script неизменны относительно HEAD. JSON двух catalogs/четырёх manifests
корректен, версии согласованы, non-Figma entries не изменены.
`git diff --check` прошёл. Grammar parse Python 3.10 выполнен для 7 helper/test
files; фактический interpreter тестового запуска — Python 3.13.7, отдельный
runtime-прогон на Python 3.10 этим не заявляется.

## Live и исторический artifact

Свежие read-only `figma_get_status({probe:true})` и `figma_list_open_files`
в этой итерации подтвердили отсутствие active/connected file: probe success=false,
files=[]. Новый live capture и end-to-end host save не выполнялись. UI не
перезапускался, макет не менялся.

Контроллер ранее в этой же итерации запустил public helper из чужого cwd на
разрешённом историческом PNG. Проверены valid PNG, expected width/height и
фактическая прозрачность: все четыре checks passed, provenance=false, input
не изменился. Helper с того запуска не менялся. Это локальная проверка
исторического artifact; она не является новым capture. Private path, dimensions,
corporate identifiers/texts/values/geometry и изображение здесь не публикуются.

## Применение инструкции

Baseline и новая редакция оценены на тех же шести held-out сценариях через
явно указанные файлы. Контроллер сравнил намеренные действия с отдельными
ожиданиями: новая редакция сохраняет ограничения capture/save/verify, existing
destination, unknown alpha/provenance, offline verification и transport loss.
Это explicit-file evaluation; фактическое обнаружение/активация skill в хосте,
формальный host RED/GREEN и численное улучшение не установлены.

## Практические границы

- Только новый native workflow/helper ограничен PNG; SVG/PDF/JPG/fills/QR,
  variable resolver и motion не добавляются. Existing REST возможности сохранены.
- Native raw cap: по умолчанию 1048576 bytes, максимум 4194304 до base64;
  encoded payload больше примерно на треть. Oversize — partial/export_size_limit
  без base64/downscale; cap не ограничивает уже выделенный Figma buffer.
- Offline regular-file read ограничен 64 MiB + sentinel; существующие decoder
  limits и warnings сохраняются. Большой поддержанный PNG может иметь alpha=unknown.
- Требование transparency проходит только при alpha=transparent; opaque даёт
  asset_mismatch, unknown — verification_unavailable. Без требования unknown
  допустим с warnings. Expected width/height — positive integers вместе.
- Local source=local-file и provenance_verified=false всегда. Pixels/alpha
  не подтверждают file/node identity, version, completeness или реальный 2×
  без независимо подтверждённых expected pixels; native version остаётся null.
- Preview не заменяет asset; transport loss оставляет исход capture неизвестным.
  Нет нового HTTP/auth пути, автоматической настройки credentials или обхода denial/429.
