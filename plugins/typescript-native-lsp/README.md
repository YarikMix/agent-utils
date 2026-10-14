# typescript-native-lsp

Нативный языковой сервер TypeScript 7 для Claude Code и Codex. Claude Code получает навигацию через встроенный LSP; Codex — [12 MCP-инструментов и скилл](codex/README.md), включая диагностику файла и переименование символа.

Официальный `typescript-lsp` по состоянию на 14.10.2026 запускает `typescript-language-server`, обёртку над `tsserver`. Здесь используется нативный `tsc --lsp --stdio`. Проверенный официальный каталог: [8d392c8](https://github.com/anthropics/claude-plugins-official/blob/8d392c8169665866be1d95f2bfeda5aaae7149dd/.claude-plugin/marketplace.json).

## Требования

Установите TypeScript 7+ глобально:

```sh
npm install -g typescript@7 --registry=https://registry.npmjs.org/
tsc --version
```

Глобальный `tsc` должен быть доступен в PATH. Codex дополнительно требует Node.js 20+ и поддерживает `TSC_PATH=/absolute/path/to/native/tsc` (на Windows — `tsc.exe`). Это путь к нативному бинарнику, а не JS-обёртке. Локальный TypeScript из проекта автоматически не выбирается; TS 6 и fallback на tsserver не поддерживаются. Версия глобального компилятора может отличаться от проектной: сверяйте результаты со штатным typecheck проекта.

## Claude Code

```text
/plugin marketplace add YarikMix/agent-plugins
/plugin install typescript-native-lsp@yarikmix-plugins
```

Перезапустите Claude Code. Отключите `typescript-lsp@claude-plugins-official`, поскольку оба плагина обрабатывают одинаковые расширения. Конфигурация Claude сохраняет прежний `tsc --lsp --stdio`.

Claude Code использует навигацию. Нативный сервер отдаёт ошибки исходников по запросу `textDocument/diagnostic`; автоматического потока ошибок файлов здесь нет. Для ошибок проекта запускайте его команду typecheck, например `tsc --noEmit`.

## Codex

```sh
codex plugin marketplace add YarikMix/agent-plugins
codex plugin add typescript-native-lsp@yarikmix-plugins
```

Откройте новую сессию после установки. Пакет включает готовый бандл и скилл `typescript-native-lsp`; сборка и `npm install` при запуске не выполняются. MCP запускает компилятор лениво при первом запросе к файлу. Авторизация сервису не требуется.

Codex может запросить диагностику файла после правки. Quick fixes возвращаются как данные и автоматически не применяются. `rename` изменяет файлы — вызывайте его только по явной просьбе переименовать символ. Подробности позиций, freshness и проверки установки — в [Codex README](codex/README.md).

## Если сервер молчит

| Симптом | Проверка |
|---|---|
| `tsc --version` ниже 7 | Установите глобальный TypeScript 7+ |
| `tsc` не найден | Добавьте глобальный каталог npm в PATH: на POSIX это `<npm prefix -g>/bin` |
| `TSC_PATH` отвергнут | Укажите абсолютный путь к нативному TS7-бинарнику |
| Плагин не появился после установки | Начните новую сессию |

Расширения: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`. Изменения неоткрытой зависимости могут становиться видны до 2 секунд; после короткой задержки повторите запрос. Ошибки чтения или сбоя сервера не означают, что результатов нет.

MCP импортирован из закреплённого upstream вручную. Автоматической синхронизации нет; процесс обновления и лицензии описаны в [UPSTREAM.md](codex/UPSTREAM.md).
