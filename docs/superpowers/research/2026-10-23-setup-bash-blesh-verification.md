# setup-bash-blesh verification — 2026-10-23

Verified package version: `1.0.0`. No user dotfiles, VS Code settings, or existing
terminals were changed. Raw client output and PTY captures remain private.

## Package checks

- `python3 <skill-creator>/scripts/quick_validate.py plugins/setup-bash-blesh/skills/setup-bash-blesh`: **PASS**, `Skill is valid!`.
- Python JSON assertions over both manifests and marketplaces: **PASS**;
  matching name/version, `./skills/`, exactly one entry per marketplace, and
  sources resolving to the package directory.
- Relative Markdown links in the root README and package documentation: **PASS**.
- `git diff --check`: **PASS**. The reported trailing `*` in `SKILL.md` is
  absent from the committed file; no skill correction was necessary.
- Existing host startup files: `bash -n` on `.bashrc` and `.blerc`: **PASS**.

The first structural-probe attempt assumed a nonexistent Codex marketplace
location. Correcting the harness to `.agents/plugins/marketplace.json` passed;
this was not a package defect.

## Live Codex decisions

Ran `codex exec -s read-only -C <worktree> -` with an explicit no-write prompt.
Runtime: **codex-cli 0.164.0**, model **gpt-6-sol**, read-only sandbox,
approval policy `never`. The runtime read `SKILL.md`, `references/setup.md`,
and `references/validation.md` through three read commands; exit status **0**.

Six synthetic scenarios covered all nine decision-matrix rows: unsupported
OS/unconfirmed WSL/missing Bash; authorized partial setup using an existing XDG
init; no VS Code or `TERM_PROGRAM`; already-working configuration and no visible
suggestion; commented remote JSONC selecting fish with another active Codex
terminal; and unavailable installation dependencies/network. Decisions matched
the matrix: preserve existing configuration and processes, reuse working
installation, make only authorized core changes, keep VS Code optional and
separately authorized, preserve JSONC, and report blockers without success claims.

This checks decisions after explicit file loading. It does **not** establish
marketplace discovery, plugin installation, or automatic skill selection.

## Existing host behavior in fresh PTYs

A private Python `pty.fork` driver launched new `bash --noprofile -i` processes,
kept streams on the TTY, handled terminal queries, and captured ANSI output.
These observations concern the host's **existing** Bash/ble.sh configuration;
the documentation plugin did not install or reconfigure it.

- Bash **5.2.21** loaded **ble.sh 0.4.0-devel4+d81fd54**. A known alias and
  standard PATH entry remained available, checked without publishing values.
- With `HISTFILE=/dev/null` and synthetic session history, a grey history
  suggestion appeared. Tab inserted the suffix into editable input; cursor
  movement traversed it. No command executed; the buffer was cancelled.
- A subsequent clean fresh-shell repeat also accepted the suggestion. An
  intervening instrumented run that enumerated bindings first instead emitted
  a bell and retained the suggestion. The cause remains unresolved; successful
  observations do not establish exhaustive repeatability.
- Normal Tab completion expanded a unique temporary filename with no suggestion
  visible. Autosuggestions were disabled **only in that test process** to
  isolate ordinary completion; its input was cancelled and artifacts removed.
- An incomplete command name and unmatched quote had no red error background
  in captured ANSI rendering. A separate query confirmed `syntax_error=none`
  and both requested `auto_complete/insert` bindings. This face also neutralizes
  other syntax-error highlighting; other token colors remain.
- Independent noninteractive `bash -c` did not load ble.sh or emit terminal
  setup output. Its parent had no inherited `BLE_VERSION`; no variable was
  removed to manufacture that result.

Initial binding/face inspection used incorrect query arguments and returned
usage errors. Correct read-only queries subsequently confirmed the settings.
The first filename test also showed an automatic suggestion, so it was repeated
with session-only autosuggestions disabled before counting ordinary completion.

## Remaining limits

No clean-machine installation or real dotfile-edit/rollback path was exercised.
Idempotency and preservation decisions were probed, not verified by applying
changes twice. No live VS Code UI/new-tab integration was tested. Claude Code
was not run: its packaging and invocation follow repository conventions, and
**live Claude Code validation remains unverified**. PTY checks used a terminal
response driver, not a graphical terminal; the instrumented Tab anomaly remains
an explicit host/harness integration gap.
