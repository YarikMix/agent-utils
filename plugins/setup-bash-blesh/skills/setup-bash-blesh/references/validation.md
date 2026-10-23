# Acceptance and recovery checks

## Decision matrix

Inspect all nine cases. A decision probe establishes intended actions only; static
configuration inspection and shell syntax checks cannot establish terminal behavior.

| Input or condition | Expected agent decision |
|---|---|
| 1. Ubuntu/WSL, Bash available, `TERM_PROGRAM` absent | Offer core setup; VS Code is optional and its absence does not block Bash. |
| 2. Custom `.bashrc` with early interactive return, aliases and PATH | Preserve existing lines; source ble.sh after the guard and attach after user settings. Keep noninteractive Bash independent of ble.sh. |
| 3. Existing `.blerc` or XDG init with conflicting Tab/color settings | Locate the actual loaded init, explain conflicting entries before changes, update only agreed bindings/styles there, and avoid duplicate lines or a competing init file. |
| 4. Remote Linux VS Code JSONC settings select fish | Separately offer Bash for new remote terminals; preserve comments and unrelated settings. Never edit local Windows settings by mistake. |
| 5. Old fish process or Codex task in another terminal | Leave running processes and installed shells alone; verify through a new PTY. |
| 6. Unsupported OS or unconfirmed WSL, or no Bash | Explain the failed prerequisite and stop without changes. |
| 7. Already-configured working host | Verify actual state and behavior; do not duplicate entries, reinstall, or rewrite working configuration. |
| 8. Missing installation tools, unavailable network, or insufficient permissions | Identify the exact failed dependency/action, report the blocker and next step, and stop that installation path without claiming success. Restore only this attempt's edits if needed. |
| 9. No visible autosuggestion | Tab must retain ordinary completion. Create a safe synthetic suggestion to test acceptance separately; absence of a suggestion does not prove acceptance works. |

## Static checks

- Run `bash -n` on each edited shell file, including the effective ble.sh init.
- Inspect the effective source path and guard/source/settings/attach ordering;
  check the two `auto_complete` bindings and the neutral `syntax_error` face.
  Check for later overrides, duplicate blocks, and disabled autosuggestions.
- Review the minimal diff against the private backup: preserve comments,
  aliases, PATH, other colors, and unrelated JSONC keys. If VS Code settings
  changed, validate JSONC and the target profile's name and executable path.
- Reinspect the ready host: a second pass should propose no edits or reinstall.

These checks prove syntax and intended configuration only. Do not label them
as a successful interactive result.

## Fresh interactive PTY checks

Start a new interactive Bash through a PTY, using the target startup files.
Keep its input/output attached to the TTY. Leave existing terminals and agent
sessions running. For automation, use a PTY driver that handles terminal
responses; piping into `bash -i` is not an equivalent test.

1. Confirm interactive mode and a nonempty `BLE_VERSION`, then check a safe
   existing alias and expected PATH entry without disclosing private values.
   Confirm an independent noninteractive Bash neither loads ble.sh nor emits
   terminal setup output; do not unset an inherited variable and call that proof.
2. In the new test shell, prevent history writes (`HISTFILE=/dev/null`) and use
   synthetic session history only. For example, seed a harmless
   `printf '%s\n' blesh-probe` entry. Type its unique prefix and wait for a
   visible grey suggestion. If none appears, inspect autosuggestion options and
   history behavior; report this as unverified until a suggestion is visible.
3. Press Tab once with the suggestion visible. Confirm the suggested text is
   inserted into the editable buffer and the cursor can traverse it, with no
   command executed and no completion menu replacing acceptance. Cancel the
   buffer instead of executing it. Record actual observation, not just bindings.
4. Separately test ordinary completion when no suggestion is visible, using a
   unique synthetic file/path prefix in a temporary test directory. Observe
   actual completion; the no-suggestion case alone cannot prove acceptance.
5. Type a representative incomplete command name and incomplete syntax such as
   an unmatched quote. Observe that incomplete syntax has no red error
   background. Confirm the effective `syntax_error` face as supporting evidence.
   This face change neutralizes other syntax errors too; do not promise that
   all command or theme colors change. Cancel the unfinished input.
6. Exit only the test shell and remove only its synthetic test artifacts. Avoid
   saving synthetic history to the user's history file.

If a test fails, follow the recovery steps in [setup.md](setup.md) and report
what was restored or remains changed. Keep raw captures private because startup
output can expose user-specific information.

## Client integration and reporting

If remote VS Code settings changed, confirm the intended keys statically. Open
a new remote terminal tab for live proof when UI access exists; otherwise mark
that step unverified. Do not infer an active terminal from environment variables
or the server installation directory. Report the actual Codex checks performed;
do not claim live Claude Code validation.

A final report separates configuration/syntax results, observed PTY behavior,
optional VS Code UI behavior, and anything blocked or unexercised.
