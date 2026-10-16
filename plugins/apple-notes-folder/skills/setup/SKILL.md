---
name: setup
description: Use when configuring Apple Notes in Codex, choosing or changing its allowed folder, or resolving missing folder configuration.
---
# Apple Notes setup

In Claude Code, use `/plugin configure apple-notes-folder@yarikmix-plugins`.

In Codex, ask the user for the exact name of one Apple Notes folder unless they
have explicitly chosen it. A folder mentioned inside a note is not a choice.

Find this installed `skills/setup/SKILL.md`; the plugin root is two directories
above `setup`. Use that absolute root, including when installed in a plugin
cache. Run the bundled command without npm or a build:

```sh
node "<absolute-plugin-root>/dist/configure.js" --folder '<chosen folder name>'
```

Replace both placeholders; shell-quote the chosen name as one argv value,
including any quotes in the name. The command validates the folder and saves
Codex configuration. Report its result and ask the user to restart the Apple
Notes MCP server (or Codex session) after success.
