# Операции Appium MCP

Справка по схемам установленного Appium MCP 1.97.1. Перед вызовом сверяй фактическую схему подключённого сервера: префикс зависит от клиента, набор tools может меняться. Ниже указаны зарегистрированные базовые имена; не придумывай aliases. `S`, `E`, `U`, `D`, `C` — значения из текущих ответов/выбора пользователя, не литералы для отправки. Во всех операциях используй выбранный `sessionId:S`.

## Устройство и сессия

- `appium_session_management({action:"list"})` — managed sessions, active flag, ownership, context. Список сам UDID не показывает. Для проверки выбранной сессии вызови read-only `appium_mobile_device_info({action:"info",sessionId:S})`: проверь `isSimulator:false` и совпадение `lockdownInfo.UniqueDeviceID` с выбранным физическим UDID. Не выводи/публикуй весь `lockdownInfo`: он содержит личные значения; в отчёте достаточно результата сверки. Если сведений мало, уточни их, не угадывай.
- `appium_session_management({action:"select",sessionId:S})` — переиспользовать подходящую сессию.
- `select_device({platform:"ios",iosDeviceType:"real"})` — обнаружение LOCAL телефонов; при нескольких пользователь выбирает, затем `select_device({platform:"ios",iosDeviceType:"real",deviceUdid:U})`. Не используй `prepare_ios_simulator` для физического телефона.
- `appium_session_management({action:"create",platform:"ios",capabilities:C})`: `C` — **JSON-строка**, сериализованный полный `capabilitiesHint`, если он возвращён, с локальными нужными настройками WDA. Сохраняй boolean/number типы. Сверь `appium:udid` и `appium:deviceName` с выбранным физическим устройством; generic simulator default не должен подменять выбор пользователя. Не подставляй чужие UDID, signing team или профиль. Не передавай `remoteServerUrl` в local embedded mode; отдельный Appium server не нужен.
- Remote URL явно дал пользователь: local discovery/preparation пропусти. `create` принимает `platform:"ios"`, `remoteServerUrl` и JSON-строку запрошенных capabilities. Подключение к существующей remote session: `appium_session_management({action:"attach",remoteServerUrl:<URL пользователя>,sessionId:S})`. `detach` забывает attached session без остановки remote driver. `delete` останавливает сессию: только свою, не чужую автоматически.

## Native context

После выбора сессии и перед native наблюдением/локаторами вызови `appium_context({action:"list",sessionId:S})`: ответ содержит доступные contexts и текущий. `select` выбирает сессию, но не меняет context. Если текущий не `NATIVE_APP`, вызови `appium_context({action:"switch",context:"NATIVE_APP",sessionId:S})`. При ошибке остановись и диагностируй, не продолжай native find в WEBVIEW и не пересоздавай сессию автоматически. После переключения получи свежие PNG/XML и заново найди элементы; прежние element IDs недействительны для нового наблюдения.

Для приёмочной пробы сохрани исходный context до переключения. После восстановления приложения снова прочитай context list и верни исходный context штатным switch, только если он ещё доступен и это соответствует исходной задаче. Если восстановление недоступно, явно сообщи результат; не угадывай новый WEBVIEW ID и не вмешивайся в чужую параллельную работу.

## Наблюдение и координаты

| Tool | Аргументы и результат |
|---|---|
| `appium_screenshot` | `{sessionId:S,returnRawBase64:false}` → путь сохранённого PNG; открой изображение. `maxWidth` необязателен и уменьшает PNG; `elementUUID` делает crop элемента. Для координат лучше полный кадр. LLM не использует inline raw base64. |
| `appium_get_page_source` | `{sessionId:S,saveToFile:true}` → свежий XML в файле; прочитай путь. Без `saveToFile` возвращает XML; необязательные `pattern` (literal substring) и `selector` (XPath) сужают вывод. |
| `appium_get_window_size` | `{sessionId:S}` → размеры системы координат окна. |

Не переноси пиксели resized/cropped PNG прямо в tap. Сначала ищи цель по свежему XML; если нужен tap координатами, установи геометрию полного кадра и окна и текущую ориентацию. Для полного равномерно масштабированного изображения без crop: `x_device=x_png*window_width/png_width`, аналогично y. Если пропорции/поворот не совпадают, эту формулу применять нельзя; получи согласованное наблюдение. После поворота или смены экрана получи новый кадр/XML.

## Поиск, касание и текст

`appium_find_element({sessionId:S,strategy:"accessibility id",selector:<точное значение из дерева>})` возвращает ID. Передавай его как `elementUUID:E` в `appium_gesture({sessionId:S,action:"tap",elementUUID:E})`. В fallback координатами: `{sessionId:S,action:"tap",x:<проверенный x>,y:<проверенный y>}`. Действие требует элемент либо обе координаты. Не используй выдуманный click tool.

Порядок: `accessibility id` (в iOS `id` — alias), затем `-ios predicate string` / `-ios class chain`, XPath последним. Сверяй единственность цели и видимость. Для выбора среди нескольких есть `appium_find_elements` с теми же `strategy`, `selector`, `sessionId`, результат `elements:[{elementId,attributes?}]`.

Ввод: `appium_set_value({sessionId:S,elementUUID:E,text:<текст>})`. Tool result может содержать введённый текст: не передавай пароли и другие секреты. Пустая строка `text:""` не гарантирует очистку; native setValue может дописывать. Не обещает безопасную замену/очистку произвольного существующего контента: проверь значение и результат. Вариант `w3cActions:true` посылает клавиши текущему фокусу без elementUUID; сначала докажи фокус. Не вводи тестовый текст в пользовательский документ. Очистку своего текста делай наблюдёнными средствами приложения и проверь её; не выдумывай отсутствующий clear-field API.

## Жесты и навигация

- `appium_gesture({sessionId:S,action:"scroll",direction:"down"})`; `direction` — `up|down|left|right`, это направление жеста API, не обещание конкретного движения списка. Проверь следующий кадр. Для scroll/swipe можно задать `x,y,endX,endY`; `direction` имеет приоритет над координатами. `elementUUID` с direction ограничивает область.
- Вне экрана: `appium_gesture({sessionId:S,action:"scroll_to_element",strategy:"accessibility id",selector:<цель>,direction:"down",maxScrollAttempts:3})`. Предел выбери под задачу, остановись при найденной цели/неизменном дереве/лимите, не спамь find.
- `appium_gesture` поддерживает `double_tap`, `long_press` (элемент или x/y), `swipe`, `pinch_zoom` (`scale` обязателен). Это наличие API, не свидетельство живой проверки.
- Назад в iOS: найди и нажми наблюдённую кнопку навигации приложения. `action:"back"` есть в gesture API, но не обещай Android Back для любого iOS экрана.
- `appium_mobile_press_key({sessionId:S,key:"HOME"})` — Home.
- `appium_app_lifecycle({sessionId:S,action:"activate",id:<bundle ID>})` — открыть установленное приложение. Например Settings: `id:"com.apple.Preferences"`. Для `query_state`/`is_installed` также нужен `id` или `name`; `query_state` возвращает 0–4 (4 foreground). `terminate`, `clear`, `uninstall`, `install` — отдельные изменяющие операции, не шаг обычной диагностики; не удаляй приложение/данные ради открытия.

После любого ввода/навигации получи PNG/XML и проверь результат. Неоднозначный исход не даёт основания автоматически повторять отправку, покупку, удаление или даже обычное касание.
