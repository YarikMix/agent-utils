---
name: codex-vscode-sessions
description: Use when a user asks Codex running in a WSL terminal of VS Code to find and open or resume an existing Codex session in a new terminal tab of the same VS Code window, including a session identified by task, PR, issue, or conversation topic.
---

# Open a Codex session in this VS Code window

Use the installed [Codex Terminal Tool](https://github.com/YarikMix/vs-code-utils) extension. Its endpoint belongs to one VS Code window; take it only from the environment of the current terminal. The extension opens a terminal in that window and runs `codex resume <session-id>`.

## Find the session

Use available Codex session tools if they can search the requested history. Otherwise search local rollouts under `${CODEX_HOME:-$HOME/.codex}/sessions` and `archived_sessions`. Search by a distinctive exact URL or phrase with `rg -l -F`; inspect matching user messages, assistant responses, and session metadata to distinguish similar conversations. The rollout's `session_meta` ID is the UUID to resume. If nothing matches, try other distinctive terms from the user's request and report when the session cannot be identified. Ask the user to choose only if the evidence leaves multiple plausible sessions.

## Open it

1. Check that `CODEX_TERMINAL_TOOL_HELPER` and `CODEX_TERMINAL_TOOL_ENDPOINT` are set in the **current process**. Do not print the endpoint: its URL contains a token.
2. Use the environment values as provided; do not hardcode an extension version or helper path.
3. Pass the verified UUID to the helper:

```sh
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "$CODEX_TERMINAL_TOOL_HELPER" \
  -Endpoint "$CODEX_TERMINAL_TOOL_ENDPOINT" \
  -SessionId "$SESSION_ID"
```

The helper's success message confirms that the extension accepted the request. Inspect the new terminal when UI access is available, or check for a newly started `codex resume <UUID>` process when possible. If only the helper response is visible, report acceptance rather than claiming the session is ready.

## If the environment is missing from a tool command

Still identify the requested session when possible and give the user its UUID. Missing variables in a Codex shell tool do **not** prove that its VS Code terminal is old: the CLI may use a shared background app-server whose tool commands inherit the server's environment instead of the terminal's. Opening another terminal and starting plain `codex` can repeat the failure.

If their status in the terminal shell is unknown, ask the user to check it without printing the endpoint:

```sh
printf 'helper=%s endpoint=%s\n' \
  "${CODEX_TERMINAL_TOOL_HELPER:+set}" \
  "${CODEX_TERMINAL_TOOL_ENDPOINT:+set}"
```

If both are set, give the current Codex session UUID (for example, `CODEX_SESSION_ID` in the tool environment). Tell the user to exit that Codex session and resume it **in the same terminal** with `codex resume <current-session-UUID> --no-daemon`, then retry opening the requested UUID. The `--no-daemon` flag keeps tool commands in the terminal's environment. If either variable is missing in the terminal shell, open a new WSL integrated terminal in the desired VS Code window after the extension activates, then start Codex there with `codex --no-daemon`. If the variables are still missing, check the extension's installation and activation in that window.

Do not extract an endpoint from another process, another terminal, or a hardcoded port: with multiple VS Code windows that can open the session in the wrong window. Do not use `code -n`, Windows Terminal, or desktop automation as a substitute for the window-scoped bridge.
