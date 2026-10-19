# agent-utils

Плагины для Claude Code и Codex. Apple Notes, Karabiner и Appium-скиллы работают в обоих клиентах;
Selectel и TypeScript LSP предназначены для Claude Code,
а Codex Disable Skill — для Codex.

## Подключение

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install apple-notes-folder@yarikmix-plugins
claude plugin install iphone-control@yarikmix-plugins
claude plugin install setup-iphone-control@yarikmix-plugins

codex plugin marketplace add YarikMix/agent-utils
codex plugin add apple-notes-folder@yarikmix-plugins
codex plugin add codex-disable-skill@yarikmix-plugins
codex plugin add iphone-control@yarikmix-plugins
codex plugin add setup-iphone-control@yarikmix-plugins
```

Добавление каталога ещё не устанавливает плагин: выполните и команду установки.
Настройка папки Apple Notes независима в каждом клиенте:
Claude — `/plugin configure apple-notes-folder@yarikmix-plugins`,
Codex — `$apple-notes-folder:setup`.

## Плагины

| Плагин | Возможности | Клиенты |
|---|---|---|
| [iphone-control](plugins/iphone-control/README.md) | Управление физическим iPhone через Appium MCP | Claude Code, Codex |
| [setup-iphone-control](plugins/setup-iphone-control/README.md) | Настройка Appium MCP и подписи WDA на Mac | Claude Code, Codex |
| [karabiner-layout-switch](plugins/karabiner-layout-switch/README.md) | Настройка Cmd+Shift для английской и русской раскладок macOS, включая Keychron K8 Pro | Claude Code, Codex |
| [apple-notes-folder](plugins/apple-notes-folder/README.md) | Apple Notes в одной папке: чтение, поиск, правка, картинки | Claude Code, Codex |
| [codex-disable-skill](plugins/codex-disable-skill/README.md) | Отключение отдельных скиллов и их подсказок | Codex |
| [typescript-native-lsp](plugins/typescript-native-lsp/README.md) | TypeScript 7 через `tsc --lsp` | Claude Code |
| [selectel-ops](plugins/selectel-ops/README.md) | облако Selectel: доступ, API, DNS, Pulumi и Ansible | Claude Code |

Apple Notes 2.0.0 принимает картинки только из подтверждённых пользовательских
вложений текущего диалога; произвольные пути и scratchpad больше не разрешены.
`dist/` включён в плагин: установка не требует npm или сборки.

Appium-плагины добавляют инструкции; подключение MCP выполняется отдельно через
`setup-iphone-control` по запросу пользователя.
