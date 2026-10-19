# figma-lookup

Чтение больших файлов Figma через подключённый MCP: поиск экранов, структура,
размеры, скриншоты, растровые исходники, QR и проверка экспорта.

## Установка

Claude Code:

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install figma-lookup@yarikmix-plugins
```

Codex:

```sh
codex plugin marketplace add YarikMix/agent-utils
codex plugin add figma-lookup@yarikmix-plugins
```

Плагин добавляет инструкции. Figma MCP подключается отдельно; названия и параметры
инструментов агент сверяет с текущим сервером. Примеры в навыке условные.

Попросите найти экран в Figma, разобрать макет, прочитать обсуждение или экспортировать
ассет. Явный вызов: `/figma-lookup:figma-lookup` в Claude Code,
`$figma-lookup:figma-lookup` в Codex.

## Опциональный Peekaboo

[peekaboo-control](../peekaboo-control/README.md) нужен только для задач, которые
не решает текущий Figma MCP:

- Просмотреть стрелку между экранами на канвасе и проверить её направление.
- Экспортировать настоящий прозрачный PNG в 2× и проверить результат.
- Прочитать полную ветку комментариев с ответами и контекстом pin.

Установите его отдельно, если нужен этот путь:

```sh
claude plugin install peekaboo-control@yarikmix-plugins
codex plugin add peekaboo-control@yarikmix-plugins
```

Настройкой Desktop, Bridge, MCP и разрешений управляет `peekaboo-control` с учётом
согласия пользователя. Без зависимости агент попросит нужный фрагмент канваса,
экспорт или полную ветку вручную. Для обычного чтения макета Peekaboo не загружается.
Комментарии читаются без отправки ответов, реакций и закрытия обсуждения.

## Границы проверки

Инструкция сохраняет ограничения ранее проверенного MCP-пути; другой сервер может
иметь иные возможности. Проверки переноса охватывают упаковку и выбор действий
свежими агентами. Полные UI-сценарии в живой Figma для стрелок, экспорта и комментариев
не проверены.

Инструкция: [SKILL.md](skills/figma-lookup/SKILL.md). Лицензия: [MIT](LICENSE).
