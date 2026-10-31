# Setup workflow

## 1. Inspect

Confirm Ubuntu using `/etc/os-release`, WSL using local evidence such as
`/proc/sys/kernel/osrelease`, `/proc/version`, or WSL environment indicators,
and Bash using its available executable/version. The agent's current shell may
be different. If any core prerequisite is absent or WSL cannot be confirmed,
explain which one failed and stop without changing files. Missing VS Code or
`TERM_PROGRAM` never blocks core setup.

Read the current user's `.bashrc`, any referenced startup files, actual ble.sh
installation, and effective ble.sh init. Avoid printing whole private configs
or history. Check for custom source arguments such as `--rcfile` first.
Normally `~/.blerc` takes precedence; only when it is absent is
`${XDG_CONFIG_HOME:-$HOME/.config}/blesh/init.sh` used. Preserve an existing XDG
init instead of creating a `.blerc` that silently shadows it. Follow explicit
custom init paths. Identify later bindings, themes, and repeated source/attach
calls that could override the proposed settings. Inspect the effective editing
mode/keymap (`set -o` and `ble-bind -m emacs --print`) and both Enter
spellings (`C-m` and `RET`), including later overrides.
The default recipe targets Emacs mode: preserve vi mode and custom keymaps,
surface incompatible bindings, and explain that Emacs bindings alone do not
configure vi mode. Do not silently switch editing modes.

Classify the host as working, partial, or unconfigured. Reuse a working install
and settings; do not reinstall solely because this skill was invoked. Inspect
remote Linux VS Code settings only if present and their target is established.
A `vscode-server` directory alone does not prove an active window or terminal.

## 2. Propose and establish authorization

Show concrete missing edits, affected paths, intended install source/revision,
and any conflicting binding/style replacement. Explain that neutralizing
`syntax_error` also removes that highlighting from other syntax errors, not
just incomplete input. Preserve other colors and options.

An inspection request requires authorization before edits. Explicit setup in
the same request already authorizes the necessary core work; do not ask twice.
Separately offer changing the remote VS Code default to Bash for new terminals;
core setup does not imply that optional preference change.

Before each edit, keep a private backup with restrictive permissions (private
directory, mode 0700; files readable only by the user). Track which files were
absent and which lines this attempt changed. Preserve symlink targets and
permissions, aliases, PATH, comments, and unrelated settings. Plan a minimal
patch instead of replacing dotfiles with templates.

## 3. Install and configure

Use the current [official ble.sh installation guidance](https://github.com/akinomyoga/ble.sh#1-usage).
Select an official release or recorded revision compatible with the installed
Bash. Check the tools and network needed for that route first: a source build
needs Git (including submodules), GNU make, GNU awk, Bash and standard utilities.
An official release archive may have different requirements; consult its
instructions. Download/inspect before execution; never use an unverified
`curl | bash`. Record the source, resolved version/revision, and actual install
path. Install only for the current user, normally under
`$HOME/.local/share/blesh`; respect a working custom location. Do not invoke
`chsh` or remove other shells/packages. If tools, network or permissions block
installation, report the exact action/error and next step; do not wire a missing
installation into startup or claim completion.

Adapt the existing `.bashrc` layout while retaining this order. The example
assumes the verified install is at the displayed path; substitute the actual
path. Keep the existing interactive guard, or add one if necessary:

```bash
# Existing interactive guard, before ble.sh loading:
case $- in
  *i*) ;;
  *) return ;;
esac
source -- "$HOME/.local/share/blesh/ble.sh" --attach=none

# Existing aliases, PATH, prompt and other user settings stay here.

# After user settings at the end of .bashrc:
[[ ! ${BLE_VERSION-} ]] || ble-attach
```

The deferred attachment matters: sourcing with default attachment near the end
is not equivalent. Do not load ble.sh in noninteractive Bash. Reconcile existing
source/attach lines instead of appending another pair. Keep source and attach
connected to the new terminal's TTY; do not test attachment through redirected
standard streams.

In the effective `.blerc`, XDG init, or explicit init file, apply exactly:

```bash
ble-bind -m auto_complete -f C-i auto_complete/insert
ble-bind -m auto_complete -f TAB auto_complete/insert
ble-bind -m emacs -f C-m 'accept-line syntax'
ble-bind -m emacs -f RET 'accept-line syntax'
ble-face -s syntax_error none
```

The Tab bindings act in `auto_complete` mode when a suggestion is visible. Keep
ordinary completion outside that mode; replacing the global Emacs Tab binding
with `auto_complete/insert-on-end` does not satisfy this contract. Both spellings
of Tab are required. Resolve later overrides and update agreed existing entries
rather than accumulating duplicates. Check options that disable autosuggestions
before claiming this behavior is available.

The two Emacs Enter bindings are part of the default setup. `accept-line syntax`
runs syntactically complete input, including a bracketed multiline paste, on
Enter without Ctrl+J. Its `syntax` modifier inserts a continuation newline for
unfinished constructs such as `if true; then` or an unmatched quote. The
MULTILINE label may remain; keep multiline editing and bracketed paste enabled.
Preserve custom keymaps and resolve conflicting Enter bindings under the same
authorization and backup rules as Tab; a matching binding needs no new entry.

Apply the updated effective init in a new terminal, or source that exact init
file in an existing Bash where ble.sh is already loaded. Reload the discovered
`.blerc`, XDG init, or explicit `--rcfile` path, not a guessed default; avoid
sourcing `.bashrc` again and repeating source/attach calls. Existing terminals
keep their current bindings until the effective init is reloaded.

## 4. Optional remote VS Code profile

Follow [official terminal profile documentation](https://code.visualstudio.com/docs/terminal/profiles).
Confirm the settings belong to the intended Ubuntu/WSL remote context, not local
Windows. After the optional change is authorized, reuse or add a Bash entry in
`terminal.integrated.profiles.linux` with the discovered Bash path as needed,
and set `terminal.integrated.defaultProfile.linux` to its exact profile name.
Use a JSONC-aware minimal edit; ordinary JSON serialization loses comments.
Preserve all other keys and profile entries. This affects new terminals: do not
kill an existing fish terminal, Codex task, or Claude session. A broken terminal
trash button or other VS Code UI fault needs separate diagnosis.

## 5. Verify or recover

Run [acceptance checks](validation.md) in a fresh interactive PTY. Reinspect a
second time to ensure the workflow would now propose no duplicate changes.
If verification fails, restore only this attempt's edits from private backups,
checking for intervening user edits first. Remove only files created by this
attempt when safe; leave a reused install alone. A clean `bash --norc -i` in a
new PTY is a recovery route that avoids loading the broken `.bashrc`.

Report observed results, failed checks, any restored or remaining changes, and
the exact next step. If PTY or client UI access is unavailable, explicitly leave
that integration unverified. Reading settings is not a live VS Code test, and
Codex testing is not live Claude Code validation.
