# Setup Bash + ble.sh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually invoked, cross-client skill that safely sets up Bash + ble.sh in Ubuntu/WSL and verifies the exact terminal behavior agreed with the user.

**Architecture:** A documentation-only plugin owns one short skill entry and two focused references: setup decisions/actions and behavioral validation. Repository manifests expose the same skill to Codex and Claude Code; a separate verification report records what was actually exercised on this host.

**Tech Stack:** Agent Skills Markdown, JSON plugin/marketplace manifests, Bash and ble.sh, VS Code Remote WSL settings.

**Spec:** `docs/superpowers/specs/2026-10-23-setup-bash-blesh-design.md`

**Execution method:** `superpowers:subagent-driven-development`, explicitly chosen by the user; continue through PR creation without a second plan approval pause.

## Global Constraints

- Plugin and skill name: `setup-bash-blesh`; initial version `1.0.0`; package for Codex and Claude Code.
- Manual developer invocation only. Inspect and propose changes first; if the same request explicitly authorizes setup, do not ask again.
- Gate core setup on Ubuntu + WSL + available Bash, not on an active VS Code terminal or `TERM_PROGRAM`.
- Keep Bash as the shell; install ble.sh for the current user. Do not use `chsh`, remove fish/zsh, kill terminals, or rewrite unrelated dotfile settings.
- Place `source -- "$HOME/.local/share/blesh/ble.sh" --attach=none` after the interactive guard and `[[ ! ${BLE_VERSION-} ]] || ble-attach` after user settings, substituting the actual install path.
- Bind `C-i` and `TAB` in `auto_complete` mode to `auto_complete/insert`; set `ble-face -s syntax_error none`; state that this neutralizes other syntax errors too.
- Change the remote Linux VS Code default profile to Bash only as a separately proposed optional step; preserve JSONC comments and other settings.
- Be idempotent, keep private backups for edits, and verify behavior in a new interactive PTY. Do not claim live Claude Code validation.
- Documentation plugin only: no installer script, MCP server, daemon, personal paths, command history, or secrets in published files.

## Review Focus

| Input or condition | Expected behavior | Owning task/check |
|---|---|---|
| Agent in Ubuntu/WSL but outside VS Code terminal | Offer core Bash setup; do not reject on missing `TERM_PROGRAM` | Task 1 scenario matrix, Task 3 read-only Codex probe |
| Custom `.bashrc` with early return and aliases/PATH | Insert source after interactive guard and attach at end without losing existing lines; noninteractive Bash unaffected | Task 1 scenario matrix, Task 3 PTY check |
| Existing `.blerc` or XDG init with conflicting Tab/color settings | Report conflict and edit only agreed entries; no duplicate lines | Task 1 scenario matrix, Task 3 decision probe |
| VS Code remote `settings.json` is JSONC with comments and non-Bash profile | Offer Bash profile separately; preserve comments and all unrelated keys | Task 1 scenario matrix, Task 3 decision probe |
| Old fish process or Codex task running in another terminal | Do not uninstall or terminate it as part of setup | Task 1 scenario matrix, Task 3 decision probe |

## File map

- `plugins/setup-bash-blesh/skills/setup-bash-blesh/SKILL.md`: explicit trigger and routing to references.
- `plugins/setup-bash-blesh/skills/setup-bash-blesh/references/setup.md`: environment check, proposal, installation, dotfile edits, optional VS Code profile, recovery.
- `plugins/setup-bash-blesh/skills/setup-bash-blesh/references/validation.md`: independent acceptance scenarios and fresh PTY checks.
- `plugins/setup-bash-blesh/{.codex-plugin,.claude-plugin}/plugin.json`, `README.md`, `LICENSE`: cross-client package.
- `.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json`, `README.md`: discoverability and install instructions.
- `docs/superpowers/research/2026-10-23-setup-bash-blesh-verification.md`: evidence and explicit Claude Code limitation.

---

### Task 1: Skill workflow and behavioral contract

**Files:**
- Create: `plugins/setup-bash-blesh/skills/setup-bash-blesh/SKILL.md`
- Create: `plugins/setup-bash-blesh/skills/setup-bash-blesh/references/setup.md`
- Create: `plugins/setup-bash-blesh/skills/setup-bash-blesh/references/validation.md`

**Interfaces:**
- Consumes: approved spec only.
- Produces: exactly one skill at `plugins/setup-bash-blesh/skills/setup-bash-blesh/`, with relative links to `references/setup.md` and `references/validation.md`; Task 2 packages this directory unchanged.

- [ ] **Step 1: Record acceptance cases before writing the workflow.** In `references/validation.md`, specify input and expected agent decision for the five Review Focus rows plus unsupported OS, already-configured host, missing installation tools/network, and no visible autosuggestion. Distinguish static config checks from a real PTY result.
- [ ] **Step 2: Verify the missing-skill baseline.** Run `python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/setup-bash-blesh/skills/setup-bash-blesh`; expect failure because `SKILL.md` does not yet exist.
- [ ] **Step 3: Write `SKILL.md` and `references/setup.md`.** Keep `SKILL.md` short; its description says explicit invocation only. `setup.md` must give ordered inspect → propose/authorize → install/configure → verify/recover instructions, exact ble.sh bindings/styles from Global Constraints, and official upstream links for ble.sh and VS Code profiles. Preserve comments/aliases/PATH and handle existing XDG `.blerc` alternatives.
- [ ] **Step 4: Validate structure and links.** Run `python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/setup-bash-blesh/skills/setup-bash-blesh` (PASS), `bash -n` on any shell snippets in temporary files, and `git diff --check` (no whitespace errors). Inspect all nine acceptance cases against the written workflow; record any unexercised case in the task report.
- [ ] **Step 5: Commit.** `git add plugins/setup-bash-blesh/skills/setup-bash-blesh && git commit -m "feat: document Bash ble.sh setup workflow"`.

### Task 2: Cross-client plugin packaging

**Files:**
- Create: `plugins/setup-bash-blesh/.codex-plugin/plugin.json`
- Create: `plugins/setup-bash-blesh/.claude-plugin/plugin.json`
- Create: `plugins/setup-bash-blesh/README.md`
- Create: `plugins/setup-bash-blesh/LICENSE`
- Modify: `.agents/plugins/marketplace.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1's `skills/setup-bash-blesh/` directory.
- Produces: both manifests with `name: setup-bash-blesh`, `version: 1.0.0`, `skills: ./skills/`; one entry in each marketplace; exact invocation and install instructions in both READMEs.

- [ ] **Step 1: Establish the discovery baseline.** Parse both marketplaces as JSON and assert `setup-bash-blesh` is absent; expect this pre-implementation check to pass.
- [ ] **Step 2: Add package metadata and documentation.** Follow the neighboring `setup-iphone-control` structure and MIT license; add Codex `interface` fields and Claude `author`/`license` fields. Document explicit invocation, Ubuntu/WSL scope, optional VS Code step, and that installing the plugin changes no dotfiles by itself.
- [ ] **Step 3: Verify package wiring.** Parse all four changed JSON files; assert exactly one new `setup-bash-blesh` entry per marketplace, manifest names/versions match, and `skills` targets exist. Run `git diff --check` and inspect the diff to confirm unrelated marketplace entries are unchanged.
- [ ] **Step 4: Commit.** `git add plugins/setup-bash-blesh/.codex-plugin plugins/setup-bash-blesh/.claude-plugin plugins/setup-bash-blesh/README.md plugins/setup-bash-blesh/LICENSE .agents/plugins/marketplace.json .claude-plugin/marketplace.json README.md && git commit -m "feat: package Bash ble.sh skill for Codex and Claude"`.

### Task 3: Validate the packaged skill and report limits

**Files:**
- Create: `docs/superpowers/research/2026-10-23-setup-bash-blesh-verification.md`
- Modify, only if a verification finding demands it: Task 1 or Task 2 files.

**Interfaces:**
- Consumes: packaged skill and manifests from Tasks 1–2.
- Produces: a concise public report with commands, outcomes, failed checks, and the untested Claude Code boundary; no raw command history or local secrets.

- [ ] **Step 1: Run structural checks.** Re-run `quick_validate.py`, JSON assertions, relative-link checks, and `git diff --check`; report exact outcomes.
- [ ] **Step 2: Exercise live Codex read-only decisions.** Use `codex exec -s read-only -C <worktree>` with a prompt that explicitly reads this skill and its references, then asks for actions on synthetic unsupported, partial-config, no-VS-Code, commented-JSONC, and active-fish/Codex cases. Require no writes. Compare decisions to `validation.md`; if CLI is unavailable, record the exact blocker instead of claiming a pass.
- [ ] **Step 3: Check real Bash behavior without reconfiguring the user's machine.** In a fresh PTY on this host, observe ble.sh loaded, a safe synthetic history suggestion, Tab accepting it without executing, neutral incomplete-command display, and normal Bash completion. Record which observations are about the host's existing configuration rather than the newly packaged skill. Do not alter or terminate existing VS Code/Codex terminals.
- [ ] **Step 4: Write report and commit.** Include Codex runtime/version, verification commands/results, no live Claude Code check, and any residual gap. `git add docs/superpowers/research/2026-10-23-setup-bash-blesh-verification.md && git commit -m "test: record Bash ble.sh skill verification"`.
