---
name: setup-iphone-control
description: Use when initially setting up physical iPhone automation through Appium MCP on a Mac, or when missing MCP tools, Xcode compatibility, device trust, Developer Mode, WDA signing or XCTest authorization block iphone-control.
---

# Настройка физического iPhone

Следуй [последовательной настройке](references/setup.md); при уже известной ошибке начни с [диагностики](references/troubleshooting.md) и продолжи с нужного этапа. Для симулятора используй другой навык.

Официальный npm `appium-mcp`, embedded XCUITest и автоматически собираемый/подписываемый WDA — основной путь. Совместимость, установка MCP, подключение tools, сборка WDA, запуск XCTest и реальное действие на телефоне проверяются отдельно. Установленный скилл не означает подключённый MCP; список сессий не доказывает живой WDA.

Определи локальные пути, версии, собственный signing Team и физический UDID. Сохраняй чужие настройки, комментарии и сессии. Не печатай целиком конфиги клиента, окружение, сертификаты и provisioning profiles: там могут быть секреты. Системные диалоги в пределах порученной задачи обрабатывай самостоятельно по свежим PNG/XML; отдельного подтверждения пользователя для нажатия их кнопок не требуется. Код-пароль, Face ID и вход в Apple Account выполняет человек.

В reuse session перед native наблюдением проверь context через `appium_context`, при необходимости переключи в `NATIVE_APP` и получи свежие PNG/XML без старых element IDs. Самостоятельная приёмка включает сохранение и восстановление исходных приложения/экрана/context, экрана Settings и очистку только своего ввода с проверкой PNG — шаги в setup.md; соседний навык для этого не нужен.

После PNG, XML и подтверждённой навигации передай выбранный sessionId, устройство и границы проверки в `iphone-control`. Если навык не установлен, используй [источник и установку iphone-control](https://github.com/YarikMix/agent-utils/tree/main/plugins/phone-control/skills/iphone-control). Установка плагина описана в README его каталога. При блокере сообщи конкретную ошибку, пройденный этап и требуемое действие человека, без обещания готового управления.
