---
name: android-control
description: Use when observing or controlling a physical Android phone through Appium MCP on a configured Mac, including screenshots, native apps, taps, text input and navigation. Not for Android emulators or initial environment setup.
---

# Физический Android через Appium MCP

Используй официальный Appium MCP с embedded UiAutomator2. На телефоне в каждый момент работает один исполнитель. Системные диалоги в пределах порученной задачи обрабатывай по свежим PNG/XML; разблокировку паролем, биометрию и доверие USB выполняет человек. Не отключай защиту телефона ради автоматизации.

## Начало работы

1. Узнай зарегистрированные tools и актуальные схемы, прочитай `appium_session_management({action:"list"})`. Готовую машину не переустанавливай.
2. Сверь выбранный физический телефон и serial/UDID с привязкой сессии. При нескольких устройствах без выбора спроси пользователя; ввод до выбора запрещён. `deviceName` и модель не доказывают идентичность. Подходящую свободную сессию переиспользуй через `select`, передавай `sessionId` явно. Не отбирай устройство у другого исполнителя.
3. Если сессии нет, вызови `select_device({platform:"android"})`, проверь физический тип и создай local embedded session по [operations](references/operations.md). Remote допустим только с URL от пользователя; не выдумывай localhost и не запускай эмулятор.
4. Перед native наблюдением вызови `appium_context({action:"list",sessionId:S})`. Если текущий context не `NATIVE_APP`, переключи его и получи новые PNG/XML. `select` не переключает context; старые element IDs после переключения не используй.

## Рабочий цикл

Свежие PNG и XML → открыть PNG → выбрать наблюдённую цель → одно действие → новое наблюдение и проверка результата. Предпочитай accessibility id, resource-id, затем Android selector; координаты — запасной путь после проверки размеров окна и масштаба PNG. Успех tool подтверждает доставку команды, а не результат на экране.

Проверяй точный введённый текст до отправки или выбора результата. Не стирай пользовательское содержимое ради пробы. После таймаута сначала наблюдай, не повторяй действие вслепую. Команды ввода, очистки, жестов, Back/Home и lifecycle — в [operations](references/operations.md); восстановление связи — в [recovery](references/recovery.md).

Перед приёмочной пробой сохрани приложение/activity, экран, положение списка и context. Убери только свой тестовый текст, восстанови исходные приложение и экран, затем исходный context, если доступен. Не сбрасывай данные ради восстановления; если точное состояние вернуть нельзя, перечисли отличие. Завершай только собственную сессию, когда это не мешает задаче. При передаче другому исполнителю передай sessionId, serial, context, последнее наблюдение и прекрати ввод сам.

При визуальной приёмке запиши параметры наблюдения и проверь обе оси масштаба по [протоколу в operations](references/operations.md#визуальная-приёмка); критерии сравнения и verdict бери из навыка `figma-ops`.

## Когда нужна настройка

Нет MCP, SDK/JDK, USB-доверия либо есть конкретная ошибка установки/instrumentation — переходи к `setup-android-control` с точной ошибкой. Если он не установлен, используй [источник и установку](https://github.com/YarikMix/agent-utils/tree/main/plugins/phone-control/skills/setup-android-control), а не отсутствующий соседний файл. Установка скилла не подключает MCP. Проверенные операции и ограничения — в [validation](references/validation.md).
