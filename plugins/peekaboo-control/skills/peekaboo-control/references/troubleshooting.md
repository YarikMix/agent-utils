# Диагностика по слою отказа

| Свидетельство | Следующий шаг |
| --- | --- |
| Запись MCP есть, tools отсутствуют | Проверить клиент, область/профиль конфига, загрузку записи, startup/handshake/tools-list ошибки и фильтры. Свежая сессия или перезапуск пользовательского клиента по необходимости; не переустановка по одному отсутствию tools |
| Process не стартует / JSON-RPC transport error | Проверить абсолютный binary, args, stdio и конкретную startup ошибку; stdout сервера предназначен для JSON-RPC |
| Explicit socket недоступен | Read-only `bridge status` по [operations](operations.md), существующий Desktop и нужный socket. Не fallback на local runtime ради успеха |
| Host/build/protocol несовместим | Проверить заявленные capabilities и необходимый режим. Обновление/настройка только в разрешённом объёме, без второго listener |
| Screen Recording/Accessibility/Event Synthesizing denied | Проверить фактический MCP `permissions` и источник Bridge; пользователь подтверждает нужный системный доступ |
| TCC granted, foreground/clipboard denied by policy | Разрешения ОС не меняют immutable policy сервера. Назвать нужный отдельный grant и согласовать по [setup](setup.md); CLI не обход |
| Sandbox `Operation not permitted`, daemon lock | Это не доказательство TCC failure. Зафиксировать слой, проверить разрешённой адресной read-only диагностикой при наличии разрешения среды; не менять TCC наугад |
| stale snapshot/owner changed/process generation changed | Новая инвентаризация и наблюдение нужного окна; не править ID и не перенаправлять старое действие другому процессу |
| Timeout/unknown/неполный outcome | Сначала свежая цель и проверка эффекта. Не повторять потенциально выполненное действие |

Если отказ явно `mutation_dispatched: false` и `retry_safe: true`, устрани указанную причину; это не разрешение слепого повтора устаревшей цели. При неизвестном исходе, возможном частичном вводе или сменившемся экране сначала сравни фактическое состояние с целью. Успех RPC не равен успеху пользовательской операции.

Clipboard не читай для проверки связи. При temporary paste проверь cleanup metadata и сохранение более новой копии пользователя. Не восстанавливай устаревший backup поверх неё. У background catalog может вообще не быть persistent write/restore: схема определяет доступное, а запрос пользователя сам не меняет процессную политику.

Собирай только относящиеся к ошибке обезличенные сведения. Не печатай полный конфиг, секреты, пути пользователя и содержимое clipboard. Не убивай соседние процессы и не ослабляй security.

Источники: [MCP lifecycle, policy и Bridge](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/mcp.md), [актуальные интерфейсы](https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md). Текущие локальные schemas/help уточняют требования установленной версии.
