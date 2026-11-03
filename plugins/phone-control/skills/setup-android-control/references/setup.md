# Настройка и приёмка

## Проверка существующей среды

Прочитай managed sessions и фактические схемы MCP. При готовом подключении сначала попробуй discovery; не устанавливай второй MCP. Найди абсолютные пути Node, Android SDK и JDK. Типовые проверки: `command -v node`, `node --version`, `npm --version`, `/usr/libexec/java_home -V`, `"$ANDROID_HOME/platform-tools/adb" version`, `"$JAVA_HOME/bin/java" -version`. Значения этих переменных сначала установи по найденным путям; вывод полного env не нужен.

Проверенная комбинация: Node 24.21.0, npm 10+, Appium MCP 1.97.1, UiAutomator2 8.7.0, appium-adb 16.1.0, JDK 17, Android 16/API 36, macOS 26.7.1. Для этих npm-пакетов пересечение engines — Node `^22.12.0 || >=24.0.0`, npm `>=10`. Это не обещание поддержки любых будущих версий. При обновлении сверяй engines/README установленных MCP и driver; UiAutomator2 8 требует Android API 26+. Xcode/WDA для Android не нужны.

SDK должен содержать platform-tools и необходимые Build-Tools. Если SDK отсутствует, установи официальные [Android SDK tools](https://developer.android.com/tools) и требуемые driver версии компонентов; не скачивай SDK заново при просто неверном пути. Лицензии принимает пользователь. Не запускай тяжёлую установку до проверки места на целевом томе. Источник требований driver: [UiAutomator2](https://github.com/appium/appium-uiautomator2-driver).

## Телефон

Подключи физический Android data-кабелем. **На телефоне**: Настройки → Параметры разработчика → Отладка по USB. Если меню скрыто: Сведения о телефоне → Сведения о ПО → Номер сборки, семь нажатий (путь зависит от производителя). Пользователь разблокирует телефон и подтверждает RSA-запрос «Разрешить отладку по USB» для своего Mac; «Всегда разрешать» — его выбор.

На Mac `adb devices -l` должен показывать `device`, а не `unauthorized`/`offline`. При нескольких устройствах спроси выбор. Все дальнейшие команды — `adb -s "$ANDROID_TASK_SERIAL" ...`, где serial взят из текущего списка. Не публикуй serial или дампы устройства. `select_device` может обнаружить эмулятор: проверь физический тип по USB, модели и `getprop ro.kernel.qemu`, не по одному deviceName.

## Установка MCP, только если его нет

Используй официальный [appium-mcp](https://github.com/appium/appium-mcp). Для воспроизведения проверенной версии:

```sh
mkdir -p "$HOME/.local/share/appium-mcp"
npm install --prefix "$HOME/.local/share/appium-mcp" --save-exact appium-mcp@1.97.1
node -p 'process.execPath'
```

Сначала проверь, что выбранный каталог не содержит другую рабочую установку. Сохрани локальный package-lock; повторная установка по нему — `npm ci --prefix "$HOME/.local/share/appium-mcp"`. Один pin верхнего пакета не фиксирует транзитивные зависимости. Не запускай `appium driver install` в другом APPIUM_HOME: MCP уже содержит embedded driver. Для другой версии сначала проверь её требования.

## Подключение клиента

Сделай приватную резервную копию конфигурации и точечно измени только запись Appium MCP. Не печатай конфиг и секреты. Существующие `CAPABILITIES_CONFIG`, iOS capabilities, `NO_UI`, command/args, timeouts и прочие серверы сохраняй. Не применяй `codex mcp add/remove` к существующему конфигу: они могут потерять комментарии менеджера конфигурации.

Пример записи Codex (`~/.codex/config.toml`); подставь фактически найденные абсолютные пути, не запускай с угловыми скобками:

```toml
[mcp_servers.appium-mcp]
command = "<абсолютный путь node>"
args = ["<каталог установки>/node_modules/appium-mcp/dist/index.js"]
startup_timeout_sec = 60
tool_timeout_sec = 300

[mcp_servers.appium-mcp.env]
NO_UI = "true"
ANDROID_HOME = "<абсолютный путь Android SDK>"
JAVA_HOME = "<абсолютный путь JDK Home>"
```

Если запись уже есть, добавляй только недостающие значения; не создавай вторую таблицу. Если ANDROID_SDK_ROOT уже задан, согласуй с ANDROID_HOME. Не уменьшай имеющийся больший timeout. Проверка TOML парсером не должна выводить значения:

```sh
python3 -c 'import pathlib,tomllib; tomllib.loads(pathlib.Path.home().joinpath(".codex/config.toml").read_text()); print("TOML OK")'
```

Для Claude Code точечно добавь такую запись в `mcpServers` выбранной области клиента (личная — `~/.claude.json`, проектная — `.mcp.json`); не заменяй весь файл:

```json
{
  "appium-mcp": {
    "type": "stdio",
    "command": "<абсолютный путь node>",
    "args": ["<каталог установки>/node_modules/appium-mcp/dist/index.js"],
    "env": {
      "NO_UI": "true",
      "ANDROID_HOME": "<абсолютный путь Android SDK>",
      "JAVA_HOME": "<абсолютный путь JDK Home>"
    }
  }
}
```

Это содержимое `mcpServers`, а не полный конфиг. JSON/JSONC редактируй с сохранением остальных записей и комментариев. При долгой первой установке клиентские `MCP_TIMEOUT=60000 MCP_TOOL_TIMEOUT=300000` задаются процессу Claude, не env дочернего MCP. Не переносить Codex `tool_timeout_sec` в JSON другого клиента. [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude MCP](https://code.claude.com/docs/en/mcp).

Перезагрузи именно MCP доступным способом, учитывая принадлежащие ему сессии; если нужен человек, дай точное действие и дождись результата. Затем снова обнаружь tools и проверь текущим подключением. Экспорт shell-env не меняет уже работающий MCP.

## Экран во время зарядки

Обычный этап поручения «настрой управление Android» — включить «Не выключать экран» при зарядке. Установка скилла и запрос «только проверь» не разрешают изменение: в этом случае прочитай состояние и сообщи результат. Выполняй этап после проверки управления (шаг 7 ниже), до восстановления сохранённых экранов Settings и исходного приложения.

На Samsung Galaxy A17 проверен путь: **на телефоне** Настройки → Параметры разработчика → «Не выключать экран», подпись «Во время зарядки экран будет всегда включен». На другом устройстве название и путь могут отличаться: найди пункт по свежим PNG/XML, не используй фиксированные координаты. Прочитай checked; если уже включён, повторно не нажимай. Если выключен — включи и проверь checked=true и PNG. При недоступном пункте зафиксируй ограничение, не обходи политику устройства.

Проверь состояние выбранного телефона read-only командами:

```sh
adb -s "$ANDROID_TASK_SERIAL" shell settings get global stay_on_while_plugged_in
adb -s "$ANDROID_TASK_SERIAL" shell dumpsys power
```

Первое значение — битовая маска источников питания, а не булево: ненулевого значения недостаточно, оно должно включать текущий источник. В `dumpsys power` проверь `mIsPowered=true`, текущий `mPlugType`, `mStayOn=true` и `mWakefulness=Awake`, если прошивка выводит эти поля. Если питания нет или поля недоступны, отличай сохранённую настройку от подтверждённого действия при зарядке. Длительное ожидание без ввода — отдельная проверка; не выдавай состояние `Awake` в момент чтения за её результат.

Не меняй тайм-аут экрана на батарее и способ блокировки. При завершении восстанови экран и context, но оставь включённое незасыпание: это результат настройки, а не временное изменение для пробы. В отчёте укажи, что экран остаётся включённым при питании; физическая кнопка блокировки и работа на батарее этим не отменяются.

## Сессия и самостоятельная приёмка

1. Прочитай `appium_session_management({action:"list"})`. Переиспользуй свободную подходящую сессию, если её привязка к выбранному serial доказана. При чужом активном исполнителе не отправляй ввод. `androidId` из device-info не заменяет ADB serial.
2. Для новой сессии — `select_device({platform:"android",deviceUdid:U})`, затем:

```js
appium_session_management({action:"create",platform:"android",capabilities:JSON.stringify({
  platformName:"Android", "appium:automationName":"UiAutomator2",
  "appium:udid":U, "appium:noReset":true,
  "appium:fullReset":false, "appium:autoGrantPermissions":false
})})
```

Не передавай `remoteServerUrl` для local embedded. Remote — только по адресу пользователя. Первая сессия устанавливает служебные APK, это отдельный этап от USB discovery. Не отключай Auto Blocker/MDM без решения пользователя.

3. Сохрани возвращённый S и передавай `sessionId:S` каждому tool. `appium_mobile_device_info({action:"info",sessionId:S})` сверяет модель/OS. До навигации зафиксируй foreground package/activity (`adb -s "$ANDROID_TASK_SERIAL" shell dumpsys activity activities`, локально фильтруя `topResumedActivity|mResumedActivity`), экран, context и исходное положение списка.
4. `appium_context({action:"list",sessionId:S})`; если нужен native switch: `{action:"switch",context:"NATIVE_APP",sessionId:S}`. Затем `appium_screenshot({sessionId:S,returnRawBase64:false})` → открыть PNG; `appium_get_page_source({sessionId:S,saveToFile:true})` → прочитать filepath/XML. Старые element IDs не использовать.
5. Открой `appium_app_lifecycle({action:"activate",id:"com.android.settings",sessionId:S})`, сохрани исходный экран Settings. Найди безопасную навигационную цель по свежему XML: `appium_find_element({strategy:"id",selector:<resource-id>,sessionId:S})`; передай `elementId` в `appium_gesture({action:"tap",elementUUID:E,sessionId:S})`. Проверь новый PNG/XML. Кроме предусмотренного этапа незасыпания, системные переключатели ради пробы менять не нужно.
6. В пустом поиске Settings введи собственную различимую строку через `appium_set_value({elementUUID:E,text:<текст>,sessionId:S})`, проверь точное значение в свежем XML и PNG. Используй наблюдённую кнопку очистки именно поля, проверь пустоту/placeholder. Не стирай чужие запросы; свою запись истории, если появилась, убери отдельно. `text:""` не считать надёжным clear API. При непустом исходном поле выбери другой безопасный способ проверки.
7. Проверь `appium_gesture({action:"scroll",direction:"up",sessionId:S})` и обратное направление по реальному смещению; на границе tool success не доказывает scroll. `appium_mobile_press_key({key:"BACK",sessionId:S})` и `key:"HOME"` также требуют нового наблюдения. Back с открытой клавиатурой может только скрыть её. После проверки управления выполни этап «Экран во время зарядки» выше, затем восстанови исходные экраны по шагу 8.
8. Верни Settings на сохранённый экран/позицию наблюдёнными переходами, затем исходное приложение через `activate` с сохранённым package. Проверь PNG/XML. Восстанови исходный context, только если он ещё доступен; не угадывай WEBVIEW ID. Назови невосстановленные отличия, не сбрасывай данные ради совпадения. Оставь собственную сессию для дальнейшей задачи либо удали только её по завершении. Передача другому агенту должна быть последовательной.

Для первоначальной настройки второй скилл не обязателен: этот smoke выполняется автономно. После приёмки передай sessionId/serial/context/результаты в `android-control` по имени. Полная чистая установка на втором Mac и автоматическое discovery скилла клиентами не подтверждены; наблюдалась настройка уже подготовленного Mac и живой контроль одного Samsung. Входы в приложения, сборка APK и работа со стендами — отдельные задачи.
