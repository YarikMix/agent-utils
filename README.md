# agent-utils

Плагины для Claude Code и Codex. Apple Notes работает в обоих клиентах;
Selectel и TypeScript LSP предназначены для Claude Code,
а Codex Disable Skill — для Codex.

## Подключение

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install apple-notes-folder@yarikmix-plugins

codex plugin marketplace add YarikMix/agent-utils
codex plugin add apple-notes-folder@yarikmix-plugins
codex plugin add codex-disable-skill@yarikmix-plugins
```

Добавление каталога ещё не устанавливает плагин: выполните и команду установки.
Настройка папки Apple Notes независима в каждом клиенте:
Claude — `/plugin configure apple-notes-folder@yarikmix-plugins`,
Codex — `$apple-notes-folder:setup`.

## Плагины

| Плагин | Возможности | Клиенты |
|---|---|---|
| [apple-notes-folder](plugins/apple-notes-folder/README.md) | Apple Notes в одной папке: чтение, поиск, правка, картинки | Claude Code, Codex |
| [codex-disable-skill](plugins/codex-disable-skill/README.md) | Отключение отдельных скиллов и их подсказок | Codex |
| [typescript-native-lsp](plugins/typescript-native-lsp/README.md) | TypeScript 7 через `tsc --lsp` | Claude Code |
| [selectel-ops](plugins/selectel-ops/README.md) | облако Selectel: доступ, API, DNS, Pulumi и Ansible | Claude Code |

Apple Notes 2.0.0 принимает картинки только из подтверждённых пользовательских
вложений текущего диалога; произвольные пути и scratchpad больше не разрешены.
`dist/` включён в плагин: установка не требует npm или сборки.
