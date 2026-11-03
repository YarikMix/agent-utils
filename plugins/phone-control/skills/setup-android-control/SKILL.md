---
name: setup-android-control
description: Use when initially configuring Appium MCP for a physical Android phone over USB on macOS, or diagnosing missing SDK/JDK, USB authorization or UiAutomator2 session startup failures. Not for routine control of a working session or app builds.
---

# Настройка физического Android на Mac

Сначала проверь существующие MCP tools, managed sessions и точную ошибку. Используй официальный `appium-mcp` и embedded UiAutomator2; отдельный HTTP Appium server, эмулятор и собственный runtime не нужны. Рабочую установку и iPhone capabilities сохрани.

При поручении настроить телефон включи «Не выключать экран» при зарядке как обычный этап и проверь результат; при запросе только проверки ничего не меняй. Настройка сохраняется после приёмки, тайм-аут на батарее не меняется.

Порядок настройки и автономная приёмка — в [setup](references/setup.md). По конкретной ошибке читай [troubleshooting](references/troubleshooting.md). Пути SDK/JDK/Node находи на этом Mac, включая подключённые внешние диски; не копируй чужие serial и домашние пути.

При нескольких телефонах пользователь выбирает устройство; все ADB-команды устройству адресуй через `-s`. Разблокировку, включение USB-отладки и RSA-доверие компьютеру выполняет человек **на Android-телефоне**, а не на Mac. Системные диалоги внутри разрешённой задачи после подключения обрабатывай по свежим PNG/XML. Изменять Auto Blocker, MDM и другие защитные настройки без явного решения пользователя нельзя.

Редактируй только нужную запись MCP реально используемого клиента, предварительно сделав приватный backup. Сохрани комментарии, остальные серверы и iOS-конфигурацию, не печатай конфиги целиком. После изменения env требуется reload MCP; отдельный диагностический процесс не доказывает исправление подключённого сервера.

Готовность означает живые PNG/XML, tap, ввод/очистку своего текста, scroll и Back/Home с восстановлением исходного экрана. Успех ADB или session create по отдельности недостаточен. Передай sessionId, serial, context, состояние экрана и ограничения в `android-control`. Если навык установлен отдельно, его [источник и установка](https://github.com/YarikMix/agent-utils/tree/main/plugins/phone-control/skills/android-control) доступны без соседнего файла. Установка скиллов не подключает MCP.
