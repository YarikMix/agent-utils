# agent-plugins

Личный маркетплейс плагинов для [Claude Code](https://claude.com/claude-code) и [Codex](https://developers.openai.com/codex/). Репозиторий: [YarikMix/agent-plugins](https://github.com/YarikMix/agent-plugins). Идентификатор каталога остаётся `yarikmix-plugins`.

## Установка

В Claude Code:

```text
/plugin marketplace add YarikMix/agent-plugins
/plugin install typescript-native-lsp@yarikmix-plugins
```

В Codex:

```sh
codex plugin marketplace add YarikMix/agent-plugins
codex plugin add typescript-native-lsp@yarikmix-plugins
```

## Поддержка

| Плагин | Claude Code | Codex |
|---|---|---|
| [typescript-native-lsp](plugins/typescript-native-lsp/README.md) | Нативный LSP TypeScript 7, навигация | [12 MCP-инструментов и скилл](plugins/typescript-native-lsp/codex/README.md), диагностика файла и rename |
| [selectel-ops](plugins/selectel-ops/README.md) | Скилл для Selectel, DNS, Pulumi и Ansible | Не портирован |
| [apple-notes-folder](plugins/apple-notes-folder/README.md) | MCP Apple Notes в границах одной папки | Не портирован |

Для Claude Code остальные плагины устанавливаются командой `/plugin install <имя>@yarikmix-plugins`. В каталоге Codex доступен только `typescript-native-lsp`.

TypeScript-плагин требует установленный глобально TS 7+. В Codex также нужен Node.js 20+; можно задать `TSC_PATH` к нативному компилятору. MCP ничего не скачивает и не запускает `npm install` при старте. `rename` записывает изменения в файлы только по явной просьбе пользователя. После редактирования запрашивайте диагностику файла, а проект проверяйте его штатными typecheck/tests.
