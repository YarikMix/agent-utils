# peekaboo-control

Управление macOS через Peekaboo MCP → Desktop Bridge. CLI дополняет отсутствующие
операции и диагностику; отказ политики MCP не разрешает обход через CLI.

## Установка плагина

Claude Code:

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install peekaboo-control@yarikmix-plugins
```

Codex:

```sh
codex plugin marketplace add YarikMix/agent-utils
codex plugin add peekaboo-control@yarikmix-plugins
```

Установка документационного плагина добавляет инструкции и **не подключает MCP
автоматически**. На готовом Mac агент проверяет существующее соединение и права.
На другом Mac сначала определяет недостающие компоненты Desktop, CLI и подключения
MCP/Bridge, затем запрашивает согласие только на их установку или настройку,
учитывая разрешения текущей сессии. Системные разрешения подтверждает человек;
foreground и temporary clipboard требуют отдельных grants.

Попросите агента управлять приложением macOS через Peekaboo.
Явный вызов в Claude Code — `/peekaboo-control:peekaboo-control`,
в Codex — `$peekaboo-control:peekaboo-control`.

Инструкция: [SKILL.md](skills/peekaboo-control/SKILL.md).
Подключение MCP для обоих клиентов: [setup.md](skills/peekaboo-control/references/setup.md).
Операции: [operations.md](skills/peekaboo-control/references/operations.md).
Диагностика: [troubleshooting.md](skills/peekaboo-control/references/troubleshooting.md).
Границы проверки: [validation.md](skills/peekaboo-control/references/validation.md).
Чистый второй Mac и полная установка в Claude Code пока не проверены.

Лицензия: [MIT](LICENSE).
