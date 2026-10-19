# Операции и выбор поверхности

Источник параметров — текущий MCP catalog/inputSchema и локальный leaf help. Таблица описывает назначение, а не гарантированное наличие инструмента. Имена могут иметь префикс сервера.

| Задача | MCP | CLI-дополнение |
| --- | --- | --- |
| Найти приложение/окно | `app`/`window`: `list` | Инвентаризация через поддерживаемый leaf help |
| Lifecycle приложения | `app`: `hide`, `quit`; `launch` только проверяет готовность уже работающего приложения | Холодный запуск, focus/switch и relaunch требуют отдельного foreground-разрешения; не обходить отказ MCP |
| Наблюдать UI | `see`: pixels + карта; `inspect_ui`: AX; `image`: только pixels | `see --help` для поддерживаемой CLI формы |
| Записать динамику/разобрать видео | `capture`: `source=live` или `video`, кадры, contact sheet, metadata; live screen/window/area | Проверить capture leaf help; выбирать background capture, наличие foreground-параметра не даёт grant |
| Разобрать готовое изображение/OCR | `analyze`: вопрос к существующему файлу, настроенный AI provider/model | Доступность provider/credentials проверять отдельно; `see` OCR — локальное наблюдение, не AI-доказательство действия |
| Нажать/перетащить/прокрутить | `click`, `drag`, `scroll` | Только отсутствующий или другой документированный режим, в рамках policy |
| Ввести текст/клавиши | `type`, `press`; прямой targeted `paste` | Параметры, snapshot receipt и режим проверять отдельно |
| Значение/выделение/AX action | `set_value`, `select_text`, `action` | Leaf `set-value`, `select-text`; background `action` отказывает для AXPress/AXShowMenu |
| Меню и диалог | `menu`: list/click; `dialog`: list/click/input/dismiss | Только разрешённые exact-target semantic действия; targetless/file/foreground маршруты не считать доступными |
| Управлять окном | `window`: close/minimize/restore/maximize/move/resize/set-bounds | Background restore не активирует приложение; focus недоступен в этом MCP |
| Spaces и перенос окна | `space`: list, move-window без follow | Switch/follow требуют foreground-разрешения; не менять видимый desktop скрытно |
| Инвентаризация Dock | `dock`: только list | Launch/context menu/hide/show Dock меняют общий UI и требуют foreground-разрешения |
| Браузер | Сначала специализированный browser tool; Peekaboo `browser` — ограниченный background маршрут существующего exact DevTools connection | status/disconnect/console/network/screenshot/performance_trace и audited call зависят от схемы и page capability; connect, discovery/navigation/evaluation здесь недоступны |
| Делегировать многошаговый workflow | `agent`: настроенный AI provider/local runtime; dry_run проверяет запрос, не результат | MCP-started agent всегда background-only; делегирование не даёт Shell, foreground или clipboard grants и не снимает запреты действий |
| Clipboard в рамках задачи | `clipboard`: status/get/save в текущем background catalog | Temporary transactional режим требует отдельного grant; обычная диагностика не читает clipboard |
| Дождаться состояния | `verify_state`; `sleep` только когда действительно нужна задержка | Не заменять проверку результата произвольным sleep |
| Права/Bridge | `permissions`; host проверить диагностикой | `bridge status`, `permissions status` с явным socket |

Дополнительные CLI-семейства без прямого одноимённого MCP tool: `screen` (дисплеи), `menubar` (status items), `move` (указатель), `clean` (snapshot/temp cleanup). Наличие семейства сверяй по локальному help, конкретный leaf — перед использованием. Cleanup удаляет данные, move/menubar могут затронуть общий UI: это не read-only диагностика и не обход background policy. `config`, `mcp`, `daemon`, `completions`, `learn`, `tools`, `visualizer` относятся к настройке, обслуживанию, справке или демонстрации; не запускай их побочные действия ради обычной GUI-задачи. Для настройки используй [setup](setup.md), для сбоев — [troubleshooting](troubleshooting.md).

Для приложений с подходящим специализированным инструментом предпочитай его. Эта карта не разрешает дополнительные действия и не гарантирует provider, host или grant: перед вызовом читай актуальную схему. Отказ политики MCP не обходи CLI или делегированием. Перечисленные дополнительные режимы не означают, что они прошли живую приёмку.

## Цели и доказательство результата

Выбери точный app/PID и окно по свежей инвентаризации. Для `see`/`inspect_ui` читай правила сочетания `app_target`, `window_id`, snapshot. `fresh: true` требует нового AX-наблюдения, но не гарантирует полного дерева. Отсутствие признака cache не доказывает свежесть. Partial/truncated/unknown не превращай в полное доказательство.

Opaque element ID и snapshot не разбирай, не сокращай и не преобразуй по виду: роль определяется свойствами элемента. ID действителен в своём наблюдении. После перехода, изменения окна, процесса, timeout или неопределённого результата получи новую цель. Большой decimal process identity передавай строкой в предусмотренном схемой поле; не прогоняй через JavaScript Number. Не подменяй его PID. При смене поколения процесса перепроверь identity и окно.

Для координат используй фактические размеры доставленного изображения и `coordinate_context`, включая origin, logical bounds, output/native scale и ROI. Не предполагай Retina ×2. Текущие `click`/`scroll` различают `global_display_points`, `image_pixels`, `normalized`; image/normalized требуют связанный `coordinate_reference`, background coordinates — свежий exact-window capture. PID сам по себе такую привязку не заменяет. OCR-текст не становится actionable element ID.

`click` выбирает ровно одну цель (`on`, `query`, `coords`). `type`/`press` в background режиме требуют свежий exact snapshot по текущей схеме; для settable AX поля подходит `set_value`. Успешная отправка события не доказывает эффект. После изменения проверяй нужное значение/выбор/переход. `verify_state` принимает структурированные predicates, различает satisfied/unsatisfied/unknown и не повторяет действия. При completion-evidence debt повторяй идентичную проверку цели и predicates согласно результату инструмента, не само действие.

## Clipboard

Прямой targeted `paste` не обязательно меняет clipboard: читай схему режима. Background catalog может разрешать лишь status/get/save и не иметь restore/set/clear. Temporary clipboard grant отдельно открывает ограниченный transactional режим; проверь cleanup/restoration в результате, не затирай более новое пользовательское содержимое вручную. Ошибка после dispatch ввода допускает уже введённый префикс: сначала прочитай цель.

## CLI и версии

Перед каждой используемой командой читай её leaf `--help`; generic help не подтверждает конкретный флаг. Проверенные диагностические формы (подставь установленный бинарник и найденный socket):

```sh
peekaboo bridge status --help
peekaboo bridge status --bridge-socket '<bridge-socket>' --json
peekaboo permissions status --help
peekaboo permissions status --bridge-socket '<bridge-socket>' --json
```

Проверь `success`, выбранный remote GUI host, build/identity и источник прав. Не допускай молчаливую подмену локальным runtime. Для screenshots CLI v4 использует `see`, а старые маршруты `list` и `image` не переноси из прежних примеров. MCP `image` при этом может существовать. `peekaboo see --help`, `peekaboo select-text --help` и `peekaboo set-value --help` подтверждают доступный синтаксис, не живое выполнение.

CLI 4.9.0 и Desktop 4.9.5 — наблюдавшаяся совместимая пара, не минимальные версии. Число инструментов не фиксируется.

Первичные источники: [MCP интерфейс](https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md), [MCP server и grants](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/mcp.md). Локальные схемы имеют приоритет над отличающимися примерами upstream.
