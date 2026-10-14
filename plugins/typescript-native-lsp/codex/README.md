# TypeScript native LSP — Codex import

Самостоятельная импортированная база `typescript-native-lsp-codex@1.1.0` для Node.js 20+. Исходник: `@zachsents/ts-mcp@0.3.7`, закреплённый коммит и карта преобразований — в [UPSTREAM.md](UPSTREAM.md).

На этом этапе сервер предоставляет шесть исходных инструментов: `hover`, `diagnostics`, `references`, `outline`, `rename`, `inlay_hints`. Позиции считаются с нуля. `rename` изменяет файлы; используйте его по явной просьбе о переименовании. Диагностика возвращает quick fixes как данные.

Запуск готового ESM-бандла требует Node и явного `TSC_PATH` к установленному нативному бинарнику TypeScript 7. При запуске сервер ничего не скачивает.

```sh
TSC_PATH=/absolute/path/to/native/tsc node dist/server.js
```

Сборка и проверки из этого каталога:

```sh
npm ci --registry=https://registry.npmjs.org/
npm run typecheck
npm run build
npm test
npm run smoke
npm run verify-build
```

Для разработки TypeScript установлен в devDependencies. Только тестовые helpers явно передают его нативный бинарник через TSC_PATH. Import test проверяет discovery, реальный hover и запуск копии бандла без node_modules; smoke проверяет исходный TypeScriptPool. Проверка сборки требует одного `server.js` и побайтного совпадения с новой временной сборкой.

Resolver, EOF/shutdown, безопасная обработка URI и расширенный набор инструментов будут изменяться следующими задачами. Эта импортированная база сохраняет исходную реализацию; манифесты Codex ещё не добавлены.

MIT, Copyright (c) Zach Sents. Лицензии включённых библиотек: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
