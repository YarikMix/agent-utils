# Точечные preferences macOS

Команды проверены на отдельном временном домене с Boolean, integer, real, data, date и вложенными массивами. Для настоящего Simulator используй домен `com.apple.iphonesimulator`. Никаких полных export/import или замены домена.

## Порядок

1. Для проверки приложение можно оставить работающим: только чтение. Сохрани следующий JXA snippet во **временный файл** `preferences.jxa`; это одноразовый рецепт, не устанавливаемый CLI.
2. Запусти `osascript -l JavaScript preferences.jxa com.apple.iphonesimulator check`. Он валидирует ВСЕ нужные типы, показывает глобальные значения (`absent` отдельно) и UDID конфликтов. Ошибка типа — остановиться **до первой записи**, не угадывать схему.
3. Для изменения работающего приложения сначала выясни последствия штатного Quit: настройки Simulator могут останавливать устройства при выходе/закрытии окон. Только при действующей авторизации на эти последствия штатно заверши Simulator и подтверди, что процесс завершился. Без неё останови запись и опиши необходимый шаг. Не используй kill/прямую правку plist/слепую перезапись при работающем приложении.
4. Снова выполни `check` непосредственно перед первой записью. При ошибке ничего не писать. Для каждого глобального ключа, который в результате не `true`, выполни соответствующую команду ниже (уже правильный пропусти). Затем `apply` перечитывает текущие данные и точечно исправляет вложенные конфликты; при отсутствии конфликтов не пишет.
5. Выполни `check` заново: оба глобальных значения `true`, conflicts пуст. При ошибке записи/синхронизации не заявляй успех: перечитай и сообщи частичный результат. Не откатывай весь домен старым снимком.
6. При разрешённом запуске/перезапуске открой Simulator, проверь целевое окно и функцию; после разрешённого штатного lifecycle перечитай `check` ещё раз. Отдельно проверь устройство без индивидуального ключа. Запись при закрытом приложении сама по себе не доказывает применение или будущую сохранность.

```sh
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool true
defaults write com.apple.iphonesimulator PasteboardAutomaticSync -bool true
osascript -l JavaScript preferences.jxa com.apple.iphonesimulator apply
osascript -l JavaScript preferences.jxa com.apple.iphonesimulator check
```

Не выполняй блок целиком без условий выше. В режиме «проверь» только `check`; `defaults write` и `apply` запрещены.

## preferences.jxa

Foundation mutable copies сохраняют нативные типы соседних полей. Чтение строго из persistent domain, не из унаследованных глобальных defaults. CFBoolean отличает Boolean от чисел 0/1. `isNil()` необходим: nil-объект JXA может быть truthy.

```javascript
ObjC.import('Foundation');
ObjC.import('CoreFoundation');
function run(args) {
 var domain=args[0], apply=args[1]==='apply';
 var prefs=$.NSUserDefaults.alloc.initWithSuiteName(domain);
 prefs.synchronize;
 var saved=prefs.persistentDomainForName(domain);
 if(saved.isNil())saved=$.NSDictionary.alloc.init;
 var devices=saved.objectForKey('DevicePreferences');
 if (!devices.isNil() && !devices.isKindOfClass($.NSDictionary)) throw Error('DevicePreferences is not a dictionary');
 var keys=!devices.isNil() ? ObjC.deepUnwrap(devices.allKeys) : [], conflicts=[];
 keys.forEach(function(k) {
  var item=devices.objectForKey(k);
  if (!item.isKindOfClass($.NSDictionary)) throw Error('Device entry is not a dictionary: '+k);
  var v=item.objectForKey('ConnectHardwareKeyboard');
  if (!v.isNil() && !v.isKindOfClass($.NSNumber)) throw Error('Unknown keyboard value type: '+k);
  if (!v.isNil() && $.CFGetTypeID(v)!==$.CFBooleanGetTypeID()) throw Error('Keyboard value is not Boolean: '+k);
  if (!v.isNil() && !ObjC.unwrap(v)) conflicts.push(k);
 });
 var globals=['ConnectHardwareKeyboard','PasteboardAutomaticSync'];
 globals.forEach(function(k){var v=saved.objectForKey(k);if(!v.isNil() && $.CFGetTypeID(v)!==$.CFBooleanGetTypeID())throw Error('Global value is not Boolean: '+k);});
 if (apply && conflicts.length) {
  var updated=devices.mutableCopy;
  conflicts.forEach(function(k){var item=devices.objectForKey(k).mutableCopy;item.setObjectForKey($(true),'ConnectHardwareKeyboard');updated.setObjectForKey(item,k);});
  prefs.setObjectForKey(updated,'DevicePreferences');
  if(!prefs.synchronize)throw Error('Preferences synchronization failed');
 }
 var state={};globals.forEach(function(k){var v=saved.objectForKey(k);state[k]=v.isNil()?'absent':ObjC.unwrap(v);});
 return JSON.stringify({globals:state,conflicts:conflicts,mode:apply?'apply':'check'});
}
```
