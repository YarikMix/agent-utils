# Default Enter verification — 2026-10-31

Scope: instruction documentation only. No user dotfiles, editing mode, running
terminal, or published package was changed. Bash **5.2.21**, local ble.sh source
revision **d81fd54**. Private harnesses/captures are excluded from the commit;
all shell fixtures used temporary HOME/init paths and `HISTFILE=/dev/null`.

## Behavior observations

A Python standard-library PTY driver used a 120×40 terminal, answered terminal
queries, and sourced the documented recipe with deferred attachment. A temporary
`C-x C-d` widget copied the editable buffer into a private fixture file for
assertions. Shell streams remained attached to the PTY.

- **RED:** with the original recipe extracted from Git, bracketed paste of
  `printf 'enter-one\n'` and `printf 'enter-two\n'`, followed by Enter (`\r`),
  produced no command output and retained the pasted buffer plus a newline.
  The buffer was cancelled.
- **GREEN:** with the updated recipe, the same input and Enter produced
  `enter-one` and `enter-two` output lines and left an empty editable buffer.
  No Ctrl+J was sent. MULTILINE remained visible before execution.
- **PASS:** `if true; then` and Enter retained an unfinished buffer with a
  continuation newline, without execution or syntax error. Completing it with
  `printf 'if-ok\n'; fi` and Enter printed `if-ok` and cleared the buffer.
- **PASS:** an unmatched quote continued; closing it and pressing Enter ran the
  completed `printf` and cleared the buffer.
- **PASS:** a visible synthetic history suggestion was generated with ble.sh's
  existing `auto-complete-enter` widget, bound only in the temporary fixture.
  Tab inserted its suffix into editable input; cursor movement traversed it.
  The buffer was cancelled without executing it. Idle history suggestions did
  not appear with either original or updated recipes in this harness; this check proves acceptance of a visible
  suggestion, not automatic idle suggestion generation.
- **PASS:** ordinary Tab completed a unique temporary filename with suggestions
  disabled only in that test process. Its buffer was cancelled.

## Configuration decision fixtures

Separate temporary fixtures inspected the effective init and printed Emacs
bindings (`ble-bind -m emacs --print`) and editing mode (`set -o`). These are
configuration/decision checks, not additional terminal behavior proof.

| Fixture | Observation and required decision |
|---|---|
| Existing XDG init, no `.blerc` | XDG init loaded; no shadow `.blerc` created. Update that init. |
| Explicit `--rcfile` plus existing XDG init | Explicit file loaded. Follow that path. |
| Later `C-m` override to `accept-line` | Printed map showed the conflicting final binding alongside matching RET. Explain and resolve the agreed override. |
| `set -o vi` | vi remained on, Emacs off. Preserve mode; Emacs entries do not configure vi behavior. |
| Matching Emacs recipe | Each desired binding appeared once; reinspection left init bytes unchanged. No new entries needed. |

This did not execute an installer/editing agent twice or exercise real backup
and rollback paths. Preservation, authorization, and backup guidance remained
in the existing workflow.

## Static checks and limits

- Skill creator `quick_validate.py`: **PASS**, `Skill is valid!`.
- `bash -n` on all **4** extracted `bash`/`sh` documentation examples: **PASS**.
- All **8** local Markdown links in the four plugin documents: **PASS**.
- `git diff --check`: **PASS**.
- Self-review against the approved spec: both exact bindings, incomplete-syntax
  continuation, effective init/overrides, preserved modes, unchanged Tab recipe,
  MULTILINE/bracketed paste, reload guidance and authorization rules covered.

Initial harness attempts used a zero-size PTY and an unsuitable single-key dump
binding; these were corrected before counting observations. A trial binding
query incorrectly used `-f` without a widget; it was confined to disposable
fixtures and replaced by `--print`. An output assertion was corrected to allow
terminal escape sequences before command output. No product change was needed
for these harness errors.

No clean-machine install, real dotfile edit/rollback, live VS Code UI, marketplace
installation/discovery, or live Claude Code integration was exercised. Independent
spec/quality review is pending with the controller.

## Copyable printf example review check

A review questioned the escaping in the three inline `printf` examples in
`references/validation.md`. Direct byte checks at implementation commit
`9241ae4` found **one** backslash in each command, already the required spelling.
No correction to those examples was necessary. Python `repr` and JSON tool output
escape that byte for display; their doubled display is not the Markdown source.

Extracted all three commands from the actual Markdown and executed them with
`bash --noprofile --norc -c` (wrapping the `; fi` example in `if true; then`).
Each exited 0, emitted no stderr, and produced exactly its label followed by one
newline: `enter-one`, `enter-two`, and `if-complete`. Byte assertions checked
exactly one backslash in each source command and byte `10` at the output end.
`git diff --check` passed. The PTY suite was not repeated for this review check.
