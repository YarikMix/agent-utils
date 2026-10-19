# iphone-control

Управление физическим iPhone через Appium MCP: экран, XML, ввод и навигация.

## Установка плагина

Claude Code:

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install iphone-control@yarikmix-plugins
```

Codex:

```sh
codex plugin marketplace add YarikMix/agent-utils
codex plugin add iphone-control@yarikmix-plugins
```

Попросите агента: «Управляй моим физическим iPhone через Appium». Явный вызов в Claude Code —
`/iphone-control:iphone-control`, в Codex — `$iphone-control:iphone-control`.

Установка плагина добавляет инструкции и **не подключает Appium MCP автоматически**.
Настройка MCP и подписи WDA выполняется по запросу пользователя через
[setup-iphone-control](../setup-iphone-control/README.md).
Нужны физический iPhone, совместимые macOS/Xcode и собственный Apple Account/Team.
Разблокировку, доверие компьютеру и системные подтверждения выполняет человек.
Симуляторы и управление через iPhone Mirroring в этот путь не входят.

Инструкция: [SKILL.md](skills/iphone-control/SKILL.md).
Управление после настройки: [iphone-control](../iphone-control/README.md).
Границы исходной живой проверки и непроверенные сценарии:
[validation.md](../iphone-control/skills/iphone-control/references/validation.md).
Первоначальная установка на втором чистом Mac и discovery скилла клиентским CLI
не подтверждены. Новая живая проверка при публикации не выполнялась.

Лицензия: [MIT](LICENSE).
