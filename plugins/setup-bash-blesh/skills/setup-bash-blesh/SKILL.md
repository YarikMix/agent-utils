---
name: setup-bash-blesh
description: Use only when a developer explicitly invokes setup-bash-blesh to inspect, configure, or verify interactive Bash with ble.sh on Ubuntu in WSL. Do not invoke automatically for general shell work or on session startup.
---

# Set up Bash with ble.sh

Keep Bash as the shell. The target is syntax highlighting, autosuggestions,
Tab acceptance of a visible suggestion, ordinary completion when none is
visible, and neutral highlighting for incomplete syntax.

1. Read [the setup workflow](references/setup.md) before inspecting and
   proposing changes. Core prerequisites are Ubuntu, WSL, and available Bash;
   neither VS Code nor `TERM_PROGRAM` is required.
2. Inspect first and show the exact missing changes. An inspection-only invocation
   does not authorize edits. If the same request explicitly authorizes setup,
   proceed within that scope without asking again. Offer the remote VS Code
   profile change separately as an optional step.
3. Apply only necessary user-local changes with private backups. Preserve user
   settings and running sessions; never use `chsh`, uninstall fish/zsh, or kill
   terminals. Repeated runs must not duplicate configuration.
4. Follow [the acceptance checks](references/validation.md). Report static checks,
   fresh interactive PTY observations, and unverified client integration
   separately. Do not claim live Claude Code validation.
