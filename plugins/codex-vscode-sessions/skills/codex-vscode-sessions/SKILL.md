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

## If the environment is missing

The extension injects these variables into **new** integrated terminals after activation. If they are missing, still identify the session when possible and give the user its UUID. Tell the user to open a new WSL terminal in the desired VS Code window, start Codex there, and ask it to open that UUID. An already running Codex process does not gain the new variables. Do not extract an endpoint from another process, another terminal, or a hardcoded port: with multiple VS Code windows that can open the session in the wrong window. Do not use `code -n`, Windows Terminal, or desktop automation as a substitute for the window-scoped bridge.
