# Первоначальная настройка на Mac

## 1. Совместимость и локальные значения

Проверь `sw_vers`, `xcode-select -p`, `xcodebuild -version`, `node --version`, `npm --version`, `command -v node`. Нужен полный Xcode, выбранный через `xcode-select`, принятая лицензия и завершённая первоначальная установка компонентов. Если активен только Command Line Tools, выбери фактический Xcode (`sudo xcode-select --switch <локальный Xcode.app>/Contents/Developer`) после установки. Xcode должен запускаться на этом macOS и поддерживать iOS телефона: сверяй [таблицу Apple](https://developer.apple.com/support/xcode/) и фактическую готовность устройства в Xcode → Window → Devices and Simulators. Не выводи совместимость из одного номера версии.

Проверенная 19.10.2026 комбинация: macOS 26.5.2, Xcode 26.6, iOS 26.6.2, Node 24.21.0, appium-mcp 1.97.1, XCUITest 12.18.1, WDA 16.16.0. Это свидетельство одной машины, а не минимальные требования. Полная установка на втором чистом Mac **не проверена**.

В 1.97.1 MCP требует Node `>=22`; bundled XCUITest/WDA — `^20.19.0 || ^22.12.0 || >=24.0.0`, npm `>=10`. Пересечение: Node `^22.12.0 || >=24.0.0`, npm `>=10`. Node 22.0–22.11 и 23.x не подходят. Используй совместимую поддерживаемую версию Node, проверяя оба engines при обновлении. Android SDK, ANDROID_HOME, JDK и отдельный глобальный Appium server/driver install для этого iPhone пути не требуются. Симуляторы устанавливать ради физического телефона не нужно.

## 2. Телефон и человеческие подтверждения

Подключи физический iPhone USB-кабелем, открой Devices and Simulators. Человек разблокирует телефон, подтверждает «Доверять этому компьютеру» и вводит код. На iOS 16+ включит Настройки → Конфиденциальность и безопасность → Режим разработчика, выполнит требуемую перезагрузку/подтверждение. В Настройки → Разработчик включит «Автоматизация интерфейса» (Enable UI Automation). Человек входит своим Apple Account в Xcode → Settings → Apple Accounts/Accounts, выбирает доступный собственный Team.

Запиши UDID локально из Xcode; при нескольких телефонах выбор делает пользователь. Не публикуй UDID, Team ID, Account, домашние пути, логи или снимки. Для native smoke Safari/Web Inspector не нужны.

## 3. Воспроизводимая локальная установка

Команды выполняются на целевом Mac; проверь существующий каталог до установки. Не перезаписывай уже рабочую установку без причины.

```sh
mkdir -p "$HOME/.local/share/appium-mcp"
npm install --prefix "$HOME/.local/share/appium-mcp" --save-exact appium-mcp@1.97.1
node -p 'process.execPath'
```

Сохрани package-lock.json локально; повторная установка по нему — `npm ci --prefix "$HOME/.local/share/appium-mcp"`. Pin верхнего пакета без lock не фиксирует все транзитивные зависимости. Проверь установленные package.json MCP, XCUITest и WDA (`version`, `engines`), путь `node_modules/appium-mcp/dist/index.js` и существование Node по абсолютному пути. При другой bundled версии повтори проверку совместимости; не подменяй pin на `latest` незаметно.

## 4. Локальная подпись WDA

Создай вне репозитория приватный `capabilities.json` и каталог derived data, например внутри выбранного выше каталога установки. Ограничь доступ: `chmod 600 <capabilities.json>`. Ниже **шаблон**, замени все значения в угловых скобках локальными; boolean/number оставь типизированными.

```json
{
  "ios": {
    "platformName": "iOS",
    "appium:automationName": "XCUITest",
    "appium:udid": "<UDID выбранного физического iPhone>",
    "appium:xcodeOrgId": "<собственный Team ID>",
    "appium:xcodeSigningId": "Apple Development",
    "appium:updatedWDABundleId": "<уникальный reverse-DNS bundle ID для своего WDA>",
    "appium:allowProvisioningDeviceRegistration": true,
    "appium:derivedDataPath": "<абсолютный локальный путь derived-data>",
    "appium:wdaLaunchTimeout": 180000,
    "appium:wdaStartupRetries": 1
  }
}
```

`CAPABILITIES_CONFIG` загружает раздел `ios`; explicit capabilities вызова имеют приоритет над файлом. Проверь UDID и Team во всём итоговом наборе, чтобы старый hint их не заменил. `updatedWDABundleId` выбирай для WDA своего Team, а не копируй идентификатор чужого приложения. Драйвер сам собирает, подписывает и устанавливает WDA через Xcode. `allowProvisioningDeviceRegistration` добавляет `-allowProvisioningUpdates` и `-allowProvisioningDeviceRegistration`; это разрешает provisioning, но не заменяет аккаунт/права/сертификат/совместимость.

Personal Team и платный Team поддерживаются. Upstream различает автоматическую настройку профиля для платного аккаунта и предварительную настройку проекта для бесплатного; успешный локальный путь с собственным Team не гарантирует чистую установку любого Personal Team. Если Xcode сообщает, что профиль создать не может, открой **установленный** `node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj`, выбери WebDriverAgentRunner, собственный Team, Automatic signing и свой уникальный Bundle Identifier, целевой телефон. Дай Xcode создать подходящий профиль и повтори driver build. Не нужен глобальный `appium driver run`: проект уже поставлен как dependency. Условия аккаунта и вход подтверждает человек.

`appium_prepare_ios_real_device` — необязательный альтернативный путь с готовым WDA/profile, не обязательный шаг этого build route. Он может показать локальные профили; `recommendedForWda` означает wildcard или `.xctrunner`. Профиль отдельного приложения не становится подходящим для WDA из-за наличия в списке. Не навязывай его UUID, не скачивай чужой prebuilt IPA ради обхода signing.

Бесплатная подпись обычно действует около семи дней: проверь фактическую ExpirationDate нужного профиля локально без вывода его полного содержимого. После истечения обнови собственное provisioning/signing в Xcode и повторно собери/установи WDA через драйвер. Скилл и npm переустанавливать из-за срока подписи не нужно.

## 5. Подключение stdio MCP без потери конфигурации

Выбери **один используемый клиент**. Найди его фактический config path/override. Сделай приватную резервную копию, проверь только целевой участок и внеси точечную текстовую вставку/замену своей записи. Не печатай весь файл. Сохрани остальные записи, настройки и комментарии; проверь diff локально без секретов и синтаксис read-only парсером. Дубликат ключа/таблицы не добавляй. В snippets нужны абсолютные пути целевой машины; `~`, `$HOME` и placeholders внутри JSON/TOML клиент не обязан раскрывать.

### Codex

Обычно `~/.codex/config.toml` (учти свой CODEX_HOME/проектную конфигурацию). Не используй здесь `codex mcp add/remove`: наблюдалась перезапись комментариев AI Launcher. Точечно вставь/обнови только собственные таблицы:

```toml
[mcp_servers.appium-mcp]
command = "<абсолютный путь node>"
args = ["<каталог установки>/node_modules/appium-mcp/dist/index.js"]
startup_timeout_sec = 60
tool_timeout_sec = 300

[mcp_servers.appium-mcp.env]
NO_UI = "true"
CAPABILITIES_CONFIG = "<абсолютный путь capabilities.json>"
```

### Claude Code

User-scope MCP обычно находится в `~/.claude.json` (учти CLAUDE_CONFIG_DIR); project scope — `.mcp.json`. Личные signing/path значения не коммить в проект. Добавь **только запись** `appium-mcp` в существующий объект `mcpServers`; если объекта нет — точечно добавь его, сохранив остальной документ. Не заменяй весь файл следующим примером и не сериализуй его целиком. Для JSONC сохраняй комментарии текстовым редактором, JSON — валидным JSON; учитывай запятые.

```json
{
  "mcpServers": {
    "appium-mcp": {
      "type": "stdio",
      "command": "<абсолютный путь node>",
      "args": ["<каталог установки>/node_modules/appium-mcp/dist/index.js"],
      "env": {
        "NO_UI": "true",
        "CAPABILITIES_CONFIG": "<абсолютный путь capabilities.json>"
      }
    }
  }
}
```

Это пример структуры, а не overwrite команда. Для долгой первой сборки клиент должен ждать дольше WDA timeout. При необходимости запусти Claude Code с `MCP_TIMEOUT=60000 MCP_TOOL_TIMEOUT=300000 claude` (миллисекунды, переменные самого клиента, не env дочернего MCP). Не уменьшай уже настроенный больший timeout. Точные defaults и per-server overrides сверяй в [официальных env vars](https://code.claude.com/docs/en/env-vars); не переносить Codex `tool_timeout_sec` в JSON другого клиента. Для других клиентов используй [upstream Appium MCP](https://github.com/appium/appium-mcp).

`NO_UI=true` отключает HTML MCP Apps UI, не автоматизацию телефона. Перезапусти MCP/клиент, затем заново обнаружь tools и их схемы; при перезапуске сервер может завершать принадлежащие ему сессии. Одной записи в файле недостаточно. Не обещай точное постоянное число tools.

## 6. Сессия, XCTest и приёмка

1. Прочитай managed sessions: `appium_session_management({action:"list"})`. Подходящую живую сессию переиспользуй через `appium_session_management({action:"select",sessionId:S})`; чужую не удаляй и не вмешивайся в параллельную чужую работу. Список сам UDID не показывает: read-only `appium_mobile_device_info({action:"info",sessionId:S})` должен подтвердить `isSimulator:false` и совпадение `lockdownInfo.UniqueDeviceID` с выбранным физическим UDID. Не выводи/публикуй весь `lockdownInfo` с личными значениями; достаточно результата сверки. Зарегистрированные tools/параметры сверяй с реальной схемой.
2. Если подходящая сессия уже выбрана, пропусти создание (шаги 2–4) и переходи к шагу 5. Иначе `select_device({platform:"ios",iosDeviceType:"real"})`; при выборе добавь `deviceUdid` с согласованным UDID. Строка default `deviceName:"iPhone Simulator"` сама по себе не доказывает симулятор: сверяй физический UDID и тип.
3. Создай `appium_session_management({action:"create",platform:"ios",capabilities:<JSON-строка проверенных capabilities>})`. Сохрани локальные signing значения и выбранный UDID при объединении hint. В local embedded mode `remoteServerUrl` опусти: отдельный сервер и выдуманный localhost URL не нужны. Remote используй только с URL от пользователя.
4. Во время первого XCTest человек держит физический телефон разблокированным и вводит требуемый код/пароль. Доступные системные диалоги в пределах задачи агент обрабатывает самостоятельно по свежим PNG/XML. При недоверенном Developer App человек подтверждает свой профиль в Настройки → Основные → VPN и управление устройством. Если timeout уже произошёл, прочитай конкретный лог. Наблюдалось: закрыть Mirroring, физически разблокировать, подтвердить XCTest, затем повторить запуск. Это не универсальная причина code 65.
5. Сохрани sessionId и исходный context через `appium_context({action:"list",sessionId:S})`. До пробы зафиксируй исходные приложение (bundle ID) и наблюдаемый экран свежим PNG; не публикуй личный кадр. Если приложение нельзя надёжно определить, уточни его до навигации. Перед native XML/локаторами проверь текущий context: если не `NATIVE_APP`, вызови `appium_context({action:"switch",context:"NATIVE_APP",sessionId:S})`. `select` сам context не меняет. При ошибке переключения остановись для диагностики, не создавай сессию заново автоматически. После переключения не используй старые element IDs: получи `appium_screenshot({sessionId:S,returnRawBase64:false})` и `appium_get_page_source({sessionId:S,saveToFile:true})`; открой PNG и прочти XML. Затем открой Settings (`appium_app_lifecycle`, `action:"activate"`, `id:"com.apple.Preferences"`), сохрани его исходный экран свежими PNG/XML перед изменением навигации, найди по актуальному XML безопасный элемент, выполни tap, проверь новый экран, вернись наблюдённой кнопкой назад и Home (`appium_mobile_press_key`, `key:"HOME"`). Для tap используй `appium_find_element` → `appium_gesture`, `action:"tap"`, `elementUUID` из ответа. Не вводи чужие данные и не меняй системные настройки ради smoke.

6. Заверши пробу самостоятельно, даже если `iphone-control` отсутствует: после проверки Home и очистки только своего тестового ввода снова активируй Settings (`appium_app_lifecycle({sessionId:S,action:"activate",id:"com.apple.Preferences"})`), верни его на сохранённый перед пробой экран наблюдёнными кнопками и проверь PNG, затем активируй исходное приложение по сохранённому bundle ID (если исходным было Settings, оставь восстановленный экран Settings). Проверь свежим PNG исходный экран приложения; не закрывай вкладки, не перезапускай и не очищай приложение ради восстановления. Затем снова вызови `appium_context({action:"list",sessionId:S})` и восстанови сохранённый context через `action:"switch"`, только если он ещё доступен и соответствует исходной задаче. После switch получи свежее наблюдение без старых element IDs и проверь итоговый PNG. Если экран/контекст нельзя безопасно восстановить, явно укажи, что восстановлено, что нет и текущее состояние; не угадывай новый WEBVIEW ID и не меняй пользовательские данные ради совпадения.

После каждого действия проверяй результат свежим наблюдением. Наличие tools, успешная сборка или даже session create не заменяют smoke. Ввод/очистку своего текста и scroll проверяй отдельно, сохраняя пользовательские данные; непроверенное назови явно. Передай управление в `iphone-control` по имени с sessionId и результатами. Если он установлен отдельно/отсутствует — источник указан в SKILL.md.

## Источники и границы

[Appium MCP](https://github.com/appium/appium-mcp), [XCUITest device setup](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/device-setup/), [provisioning](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/provisioning-profile/), [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code settings](https://code.claude.com/docs/en/settings). Сверены installed sources 1.97.1/12.18.1/16.16.0. Живой контроль готового Mac подтверждал session, PNG/XML, Settings → About → Back → Home; он не доказывает установку на чистом Mac или работоспособность любой новой версии.
