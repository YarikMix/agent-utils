# Enter after multiline paste in setup-bash-blesh

## Intent

Make Enter run a complete pasted multiline command by default when the user
requests setup-bash-blesh configuration. The user explicitly chose the default
behavior rather than a separately requested option. Inspection-only invocations
must continue to leave dotfiles unchanged.

## Approaches

- Default configuration: add the two Enter bindings to the existing ble.sh init
  recipe and verify them alongside Tab acceptance. This is the selected behavior.
- Optional configuration: document the bindings as a troubleshooting option.
  Rejected because the user wants normal setup to include them.

The proposed implementation uses the existing recipe and reference files;
it needs no installer script, new dependency, or additional configuration option.

## Behavior and scope

Add these bindings to the effective ble.sh init:

```bash
ble-bind -m emacs -f C-m 'accept-line syntax'
ble-bind -m emacs -f RET 'accept-line syntax'
```

Both Enter spellings execute syntactically complete input, including a pasted
multiline block. The `syntax` argument retains continuation for unfinished Bash
constructs such as `if true; then` or an unmatched quote. The MULTILINE label may
still appear: this changes Enter behavior rather than hiding the label or
disabling multiline editing and bracketed paste.

The recipe targets the existing Emacs editing mode. Preserve custom keymaps
and surface an incompatible existing binding instead of silently changing a
user's editing mode or claiming that these Emacs bindings configure vi mode.
Reuse the current rules for effective init discovery, private backups,
preservation of settings, later overrides, and idempotent updates.

Update SKILL.md, references/setup.md, references/validation.md, and the existing
plugin README so the documented default and verification agree. Existing shell
sessions remain running; explain how a new terminal or reloading the effective
init applies the changes. Do not modify this computer's dotfiles again.

## Validation

- Validate skill metadata, local reference links, and shell example syntax.
- In an isolated interactive Bash PTY with synthetic history, paste a harmless
  multiline command and press Enter: it must execute without Ctrl+J.
- Press Enter after an unfinished `if`, finish the construct, and press Enter:
  the incomplete input must continue and the completed command must execute.
- Retain the existing Tab-with-suggestion and ordinary-completion checks;
  reinspect to ensure a repeated setup adds no duplicate bindings.
- Distinguish observed PTY behavior from unverified live client integration.

No new runtime script, unrelated shell settings, or publication is included.
