# typescript-native-lsp

Языковой сервер TypeScript 7 для Claude Code: переход к определению, поиск ссылок, hover, символы документа и иерархия вызовов. Ошибки типов плагин не показывает — см. «Ограничения».

Официальный плагин `typescript-lsp` запускает `typescript-language-server` — обёртку над `tsserver.js`. В TypeScript 7 `tsserver.js` нет: языковой сервер встроен в сам компилятор и запускается командой `tsc --lsp --stdio`. Этот плагин подключает именно его.

## Требования

TypeScript 7 или новее, установленный глобально:

```bash
npm install -g typescript@7
tsc --version
```

Ожидается `Version 7.x`. С TypeScript 6 и старше плагин не работает: флаг `--lsp` им неизвестен.

## Установка

```text
/plugin marketplace add YarikMix/agent-utils
/plugin install typescript-native-lsp@yarikmix-plugins
```

После установки перезапустите Claude Code: языковые серверы поднимаются на старте сессии.

## Installation

Requires TypeScript 7+ installed globally (`npm install -g typescript@7`; `tsc --version` must print `Version 7.x`).

```text
/plugin marketplace add YarikMix/agent-utils
/plugin install typescript-native-lsp@yarikmix-plugins
```

Restart Claude Code afterwards. Disable the official `typescript-lsp` plugin: both claim the same file extensions.

Navigation only: the native server reports type errors on request (`textDocument/diagnostic`) and Claude Code does not ask for them. Run `tsc --noEmit` to see errors.

## Несовместимость с `typescript-lsp`

Отключите официальный плагин `typescript-lsp@claude-plugins-official`: оба претендуют на одни и те же расширения файлов. Кроме того, с глобальным TypeScript 7 официальный плагин выдаёт ложные ошибки — `Cannot find name 'Element'`, `Cannot find name 'Node'`, `Property 'push' does not exist on type '{}'` — при чистом `tsc --noEmit`.

В `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "typescript-lsp@claude-plugins-official": false,
    "typescript-native-lsp@yarikmix-plugins": true
  }
}
```

## Если LSP молчит

| Симптом | Причина | Что сделать |
|---|---|---|
| `tsc --version` печатает 6.x или ниже | флаг `--lsp` неизвестен, сервер не стартует | `npm install -g typescript@7` |
| `tsc: command not found` | глобальный каталог npm не в PATH | добавить в PATH каталог из `npm prefix -g` (на POSIX — его подкаталог `bin`) |
| всё установлено, но ссылок и hover нет | сессия запущена до установки плагина | перезапустить Claude Code |

## Ограничения

**Только навигация, без ошибок типов.** Сервер `typescript-go` 7.0.2 не рассылает ошибки исходников сам: через `textDocument/publishDiagnostics` он публикует только диагностику `tsconfig.json`, а ошибки файла отдаёт в ответ на запрос `textDocument/diagnostic`. Claude Code такой запрос не делает, поэтому после правки с ошибкой типа блок диагностики не приходит. Проверено 2026-09-19: файл с `const x: number = "text"` даёт `TS2322` от `tsc --noEmit` и ничего — от плагина. Ошибки смотрите компилятором: `tsc --noEmit`.

**Глобальный TypeScript.** Работает глобальный TypeScript, а не копия из `node_modules` проекта. Держите глобальную версию не ниже той, что записана в `package.json`: на расходящихся версиях типы в hover могут отличаться от того, что видит компилятор проекта.

Расширения файлов: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`.
