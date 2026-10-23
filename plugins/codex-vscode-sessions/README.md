# Codex VS Code Sessions

Скилл для Codex CLI в WSL: найти прежнюю сессию Codex и открыть её в новой вкладке терминала **того же окна VS Code** через расширение [Codex Terminal Tool](https://github.com/YarikMix/vs-code-utils).

## Установка

Установите расширение Codex Terminal Tool в локальный Windows VS Code и откройте новый WSL-терминал после активации расширения. Затем установите плагин:

```sh
codex plugin marketplace add YarikMix/agent-utils
codex plugin add codex-vscode-sessions@yarikmix-plugins
```

Запустите Codex в этом терминале с `codex --no-daemon`, чтобы команды агента получили переменные расширения и увидели новый скилл. Обычный запуск может подключиться к общему фоновому серверу Codex: тогда переменные есть у терминала и интерфейса Codex, но отсутствуют у команд агента. Для продолжения существующей сессии используйте `codex resume <UUID> --no-daemon`. Для явного вызова скилла: `$codex-vscode-sessions:codex-vscode-sessions`.

Скилл задаёт порядок поиска и открытия; терминал создаёт установленное расширение. Он не устанавливает и не обновляет расширение.
