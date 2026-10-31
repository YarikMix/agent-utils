# ble.sh Enter Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Enter execute complete multiline input by default in the setup-bash-blesh recipe.

**Architecture:** Extend the existing Emacs binding recipe and its acceptance
instructions. Keep the skill as documentation; reuse the existing local ble.sh
installation for isolated PTY checks.

**Tech Stack:** Markdown, Bash, ble.sh, interactive PTY.

**Spec:** `docs/superpowers/specs/2026-10-31-blesh-enter-default-design.md`

## Global Constraints

- Use `ble-bind -m emacs -f C-m 'accept-line syntax'` and
  `ble-bind -m emacs -f RET 'accept-line syntax'` by default.
- Preserve continuation for incomplete syntax and ordinary Tab completion.
- Do not disable bracketed paste, hide MULTILINE, or change editing modes.
- Reuse effective-init discovery, backups, preservation, and idempotency rules.
- No new runtime script, dependency, local dotfile changes, or publication.
- Do not implement until the user chooses the execution method.

## Review Focus

- A custom XDG or explicit init must receive bindings without being shadowed.
- A later Enter override must be identified rather than silently ignored.
- Existing vi mode must not be switched or reported as configured by Emacs bindings.
- Incomplete quotes and `if` statements must continue instead of executing early.
- Tab must accept a visible suggestion and retain completion when none is visible.

## Task 1: Update the default recipe, explanation, and acceptance checks

**Files — modify:**
- `plugins/setup-bash-blesh/skills/setup-bash-blesh/SKILL.md`: target behavior.
- `plugins/setup-bash-blesh/skills/setup-bash-blesh/references/setup.md`: exact
  default bindings, effective-keymap/override inspection, and application to a
  new terminal or reloaded effective init.
- `plugins/setup-bash-blesh/skills/setup-bash-blesh/references/validation.md`:
  decision cases, static checks, and observable PTY checks.
- `plugins/setup-bash-blesh/README.md`: concise description of default Enter behavior.

**Interfaces:** Consumes the existing init recipe and acceptance workflow;
produces consistent instructions for future setup agents. No runtime API changes.

- [x] **Step 1: Reproduce the missing behavior in an isolated PTY.**
  Use temporary init files, synthetic history, and `HISTFILE=/dev/null`.
  Load the current recipe without the user's real init. Paste two harmless
  `printf` commands using bracketed paste, then send Enter (`\r`). Confirm no
  command runs and the buffer gains a newline; cancel it. This is the baseline
  failure, not a reason to modify the user's working configuration.
- [x] **Step 2: Update the four existing documentation files.**
  Include both exact bindings above in the default recipe. Explain the `syntax`
  modifier and remaining MULTILINE label. Extend current override/conflict and
  actual-init instructions rather than adding another setup mechanism. Preserve
  inspection-only behavior and existing user authorization rules.
- [x] **Step 3: Verify the updated recipe in a fresh isolated PTY.**
  Paste `printf 'enter-one\n'` and `printf 'enter-two\n'` as one multiline
  buffer, then Enter: assert both output lines appear without Ctrl+J. Type
  `if true; then` and Enter: assert continuation without execution or syntax
  error, then complete the block and assert its output. Repeat with an unmatched
  quote, then close it and execute. Run the existing visible-suggestion Tab and
  no-suggestion completion checks. Keep raw captures private and remove only
  temporary test artifacts.
- [x] **Step 4: Verify guidance for conflicting configurations.**
  Check the updated instructions against concrete fixtures with a preexisting
  XDG init, an explicit `--rcfile`, a later Enter override, and vi mode. Confirm
  that the instructions select the actual init, surface conflicts, and preserve
  editing mode. Reinspection of a matching Emacs configuration must propose no
  duplicate bindings. Record these as decision checks, separate from PTY proof.
- [x] **Step 5: Validate and review the change.**
  Run `python3 /home/oleg/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/setup-bash-blesh/skills/setup-bash-blesh`.
  Run `bash -n` on the extracted shell examples, check local Markdown links,
  and run `git diff --check`. Review all four files against the spec and resolve
  review findings through the chosen execution workflow. Report untested client
  integration explicitly; do not claim live Claude Code validation.
- [x] **Step 6: Commit the verified change and execution record.**
  Follow the selected execution skill's journal and review requirements. Include
  the approved spec, this plan with completed checkboxes, the four documentation
  files, and the required verification/journal artifact in a focused commit:
  `docs: make Enter run multiline input in Bash setup`.

- [ ] **Independent spec and quality review:** controller review after the implementation commit.

## Plan self-review

One task owns all four files because they describe one setup contract. The
default bindings, continuation, label explanation, application instructions,
conflict handling, Tab regression checks, and idempotency each have a step.
No unrelated package tests, new runtime helper, or dotfile changes are needed.
