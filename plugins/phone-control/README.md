# phone-control

Настройка и управление физическими iPhone и Android через официальный Appium MCP,
клавиатура и буфер обмена iOS Simulator.

| Скилл | Назначение |
|---|---|
| [iphone-control](skills/iphone-control/SKILL.md) | Управление готовым физическим iPhone: PNG/XML, ввод, жесты и навигация |
| [android-control](skills/android-control/SKILL.md) | Управление готовым физическим Android через embedded UiAutomator2 |
| [setup-iphone-control](skills/setup-iphone-control/SKILL.md) | Настройка Appium MCP, Xcode и подписи WDA для физического iPhone на Mac |
| [setup-android-control](skills/setup-android-control/SKILL.md) | Настройка Android SDK/JDK, USB-доверия, Appium MCP и незасыпания при зарядке |
| [setup-ios-sim](skills/setup-ios-sim/SKILL.md) | Клавиатура Mac и синхронизация буфера обмена iOS Simulator |

## Установка

Claude Code:

```sh
claude plugin marketplace add YarikMix/agent-utils
claude plugin install phone-control@yarikmix-plugins
```

Codex:

```sh
codex plugin marketplace add YarikMix/agent-utils
codex plugin add phone-control@yarikmix-plugins
```

Явные вызовы в Claude Code: `/phone-control:iphone-control`,
`/phone-control:android-control`, `/phone-control:setup-iphone-control`,
`/phone-control:setup-android-control`.
В Codex: `$phone-control:iphone-control`, `$phone-control:android-control`,
`$phone-control:setup-iphone-control`, `$phone-control:setup-android-control`. Автоподбор по описанию сохраняется.

При переходе с прежних плагинов `iphone-control` и `setup-iphone-control` отключите
или удалите установленные старые плагины в клиенте и установите либо обновите
`phone-control` до версии 1.2.0 или новее. Имена скиллов сохраняются, меняется префикс
плагина: `/setup-iphone-control:setup-iphone-control` заменяется на
`/phone-control:setup-iphone-control` в Claude Code, а
`$setup-iphone-control:setup-iphone-control` — на `$phone-control:setup-iphone-control` в Codex. Локальные симлинки скиллов и плагин одновременно создают дубли — выберите
один способ установки. Обновите маркетплейс и перезапустите клиент после перехода.

Плагин содержит инструкции и **не подключает Appium MCP автоматически**.
Первоначальную настройку выполняют входящие в плагин
[setup-iphone-control](skills/setup-iphone-control/SKILL.md) и
[setup-android-control](skills/setup-android-control/SKILL.md).
Для iPhone нужны совместимые macOS/Xcode и собственный Apple Account/Team.
При настройке Android обычный этап — включить «Не выключать экран» при зарядке
и проверить результат; запрос «только проверь» не разрешает менять эту настройку.
Разблокировку телефона, доверие компьютеру и вход в аккаунты выполняет человек.
Системные диалоги внутри порученной задачи агент обрабатывает по свежему экрану.
WebView/Chromedriver и управление эмуляторами/симуляторами через Appium не входят в основной сценарий.

`setup-ios-sim` использует preferences macOS и Peekaboo для GUI, отдельно от Appium.
Вызов: Claude Code — `/phone-control:setup-ios-sim`, Codex — `$phone-control:setup-ios-sim`.
Установка инструкций сама настройки не меняет: «проверь» выполняется без записи,
«настрой» разрешает описанные изменения. Peekaboo нужен для автоматизации GUI,
а не для чтения глобальных значений; без него UI проверяют вручную.
Нужны заранее установленные Xcode и iOS runtime; Peekaboo автоматически не устанавливается.

Границы живых проверок: [iPhone](skills/iphone-control/references/validation.md),
[Android](skills/android-control/references/validation.md). Установка на втором чистом
Mac и автоматическое обнаружение нового пакета клиентскими CLI не подтверждены.

Лицензия: [MIT](LICENSE).
