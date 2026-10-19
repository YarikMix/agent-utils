# Настройка другого Mac

## Инвентаризация до изменений

Установи фактический клиент (Codex или Claude Code), версию macOS, наличие Desktop и CLI, доступные MCP tools, живой Bridge и системные права. Найди абсолютный путь бинарника и socket именно этого Mac. Для CLI версии используй `peekaboo --version`; диагностические команды с явным socket — в [operations](operations.md). Через фактический MCP проверь `permissions`; наличие записи конфига ещё не означает tools в текущем процессе.

Если готовый контур работает, используй его. Разные версии Desktop/CLI сами по себе не причина переустановки. Если tools нет, сначала [диагностика загрузки](troubleshooting.md).

## Недостающие компоненты

Перечисли только отсутствующее: Desktop, CLI или подключение MCP к Bridge. До установки/настройки запроси разрешение, если его ещё не было в сессии. Это требование переносимого сценария; read-only инвентаризация не требует повторного разрешения на установку.

После согласия следуй актуальной [официальной установке](https://github.com/openclaw/Peekaboo/blob/main/docs/install.md) и [странице установки](https://peekaboo.sh/install.html): Desktop распространяется отдельно от CLI; официальный notarized CLI и Mac app предпочтительны для Bridge. Не заменяй исправление соединения запуском второго daemon/listener. Не отключай TLS verification, проверку подписи, quarantine или системную защиту. После установки проверь версии, Desktop host и соединение. Права в System Settings и системные диалоги подтверждает пользователь.

## Явное MCP → Desktop подключение

[Сервер Peekaboo](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/mcp.md) использует stdio и существующий Bridge:

```sh
peekaboo mcp serve --help
peekaboo mcp serve --bridge-socket '<bridge-socket>'
```

В конфиге используй абсолютные локальные пути, а не буквальные placeholders. Не запускай эту долгоживущую команду дополнительно, если клиент уже владеет сервером. Desktop предоставляет Bridge; MCP не должен создавать второй Bridge listener. Автовыбор host недостаточен для проверки Desktop.

Сначала установи область и файл конфига фактического клиента. Прочитай только нужную запись без вывода секретов; сохрани приватный backup. Добавь/исправь только блок Peekaboo, сохранив комментарии, соседние записи и текущую область. Не переписывай весь файл и не печатай полный конфиг.

Codex: пример блока TOML для применимого `config.toml` (область проверь в [официальной документации MCP](https://developers.openai.com/codex/mcp/)):

```toml
[mcp_servers.peekaboo]
command = "/absolute/path/to/peekaboo"
args = ["mcp", "serve", "--bridge-socket", "/absolute/path/to/bridge.sock"]
```

Claude Code: stdio запись JSON, которую нужно слить с существующим `mcpServers` в выбранной области (см. [области MCP](https://code.claude.com/docs/en/mcp)):

```json
{
  "mcpServers": {
    "peekaboo": {
      "command": "/absolute/path/to/peekaboo",
      "args": ["mcp", "serve", "--bridge-socket", "/absolute/path/to/bridge.sock"]
    }
  }
}
```

Это примеры структуры, не команда перезаписи конфига. Приватные пути определяются на машине. Ни один блок не включает foreground или temporary clipboard grants.

## Grants и перезапуск

[Leaf help и документация](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/mcp.md) разделяют `--allow-foreground` и `--allow-temporary-clipboard`. Первый разрешает foreground/global UI именно процессу сервера; второй — bounded temporary clipboard без foreground. При конкретном блокере объясни нужный grant и запроси его явно. Только после авторизации точечно добавь нужный флаг в args нужного сервера и запусти собственный новый проверочный процесс. Tool arguments, prompt и TCC не меняют immutable authority уже работающего сервера.

Собственный тестовый процесс можно перезапустить; пользовательский клиент попроси перезапустить, если он не перечитывает запись. Не завершай чужие сессии и процессы. В свежем процессе проверь фактический catalog/schema, explicit Desktop host и MCP permissions, затем [приёмку](validation.md). Установка документационного плагина этих шагов не выполняет.
