# setup-sdd-ponytail: validation

Date: 2026-10-27. Scope: Task 1 in the [implementation plan](../plans/2026-10-27-setup-sdd-ponytail.md), against the [approved design](../specs/2026-10-27-setup-sdd-ponytail-design.md).

## Method

Fourteen synthetic profiles were frozen before writing the skill. Each has an original snapshot, a request, exact expected changed paths and neighboring text markers. The agreed rule is an input contract for both baseline and guided runs; the baseline receives neither the new skill nor expected decisions. The base paragraph is extracted verbatim from the approved design for comparison.

Fresh Codex CLI processes operate on copies outside the repository, with their normal authentication and without changing `HOME` or `CODEX_HOME`. Each process is instructed to read and write only its case directory; the guided run additionally reads the skill explicitly. The checks compare created/changed paths, preservation of existing lines including whitespace, the exact base paragraph, both propagation/acceptance instructions and duplicate memory links. Complete-rule and check-only cases require zero file changes. The partial-note result is reused for an additional idempotence run.

These are decision and file-write tests on simulated client profiles. They do not prove that either client automatically loads its real global instructions or that an SDD task follows the saved rule.

## Results

The full baseline completed before skill creation: **9 PASS, 5 RED**, all with completed model turns and observed file changes. The RED results are behavioral failures, separate from the initial infrastructure errors below.

| Frozen scenario | Baseline | Observed baseline writes | Guided run |
|---|---|---|---|
| Codex: custom home, nonempty override | PASS | Only active override | PASS |
| Codex: custom home, empty override | RED | Populated inactive override instead of `AGENTS.md` | PASS |
| Claude profile: absent native file | PASS | Created native user file, no PAIW | PASS |
| Claude profile: existing native file | PASS | Extended native user file | PASS |
| Claude profile: custom configuration directory | PASS | Only custom user file | PASS |
| Connected global memory | PASS | One note and one index link | PASS |
| Unconnected PAIW and project memory | PASS | Only native global instructions | PASS |
| Connected partial note | RED | Extended note and duplicated rule in native instructions | PASS |
| Connected complete note | RED | Added duplicate rule to native instructions | PASS |
| Symlink to managed instructions | RED | Created a shadowing override | PASS |
| Conflicting explicit user rule | RED | Replaced the user's rule without clarification | PASS |
| Check-only request with partial rule | PASS | Zero diff | PASS |
| Current-client setup with second client present | PASS | Only requested client | PASS |
| Setup without plugin confirmation | PASS | Prepared requested instructions; plugin use unconfirmed | PASS |

The extra baseline repeat produced zero diff on the partial-note result, while preserving its earlier duplication. It establishes idempotence of that result, not correctness of the preceding write.

Representative baseline rationalizations:

> «его `AGENTS.override.md` пуст. Запишу правило туда … поскольку непустой override имеет приоритет»

> «Дополню её текстом из контракта и добавлю полное правило в глобальный …»

> «Сохраню файл и ссылку; создам глобальный `AGENTS.override.md` … Codex отдаёт этому файлу приоритет»

> «Заменю его полным текстом … сохранив соседние инструкции»

The skill addresses these decisions through explicit source selection, in-place completion, protection and conflict conditions. Baseline passes remain passes; no improvement is claimed for those scenarios.

The first guided run completed with **13 PASS, 1 FAIL** and observed skill-read output in all fourteen processes. The remaining complete-note failure appended only a scope explanation: the unconditional instruction to explain scope competed with the explicit zero-diff condition. The original result and first skill version are preserved privately. The narrow correction makes scope text part of a new entry and puts the explanation in the report for an already complete entry. The original fixtures and expectations remain unchanged. Fresh reruns of complete, partial and newly created memory entries all PASS after that correction; the other eleven first-run passes remain unchanged. Thus the final matrix has fourteen passing scenarios, with the correction rerun distinguished from the first run.

A fresh repeat on the corrected partial-note result also PASS: zero changed paths, no additional note or index link. Exact full skill text, including the corrected scope condition, is present in completed read-command output for each corrected run. Frozen original file hashes remain unchanged.

| Evidence level | Result |
|---|---|
| Synthetic profile writes | Fourteen final scenario PASS results, plus corrected repeated setup with zero diff |
| Automatic global-instruction loading in a new native client | Unverified |
| Observed execution of a real SDD task | Unverified; no full SDD task is run by setup validation |

## Client and documentation limits

- Test clients: Codex CLI `0.164.0`; Claude Code `2.1.302`.
- `codex --help` and `codex exec --help` succeeded. The first sandboxed launch could not initialize its in-process app-server; one scoped execution with approved expanded permissions succeeded. Model-generated commands retain `workspace-write` isolation.
- `claude --help` succeeded, but the scoped print-mode launch returned `is_error: true` and `Not logged in · Please run /login` before any model action. Native Claude Code behavior is unverified. No login, credentials or endpoint changes were attempted.
- Official Claude Code [memory](https://code.claude.com/docs/en/memory) and [settings](https://code.claude.com/docs/en/settings) pages were read. They confirm user-level `~/.claude/CLAUDE.md`, repository scope of default auto memory and relocation of home-directory files with `CLAUDE_CONFIG_DIR`.
- The design's official [Codex AGENTS.md source](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and the current developer documentation URL returned HTTP 403. Live revalidation of that source is unavailable; the specified Codex selection contract remains the test expectation.

No real user memory is edited for these tests. Raw transcripts, temporary profile names and personal paths are retained only in private test artifacts, not in this report.

## Reproduction and static checks

Each phase restores a fresh copy of the frozen original. Baseline requests name the simulated client and configuration directory and provide the agreed rule. Guided requests additionally authorize and require reading [SKILL.md](../../../plugins/setup-sdd-ponytail/skills/setup-sdd-ponytail/SKILL.md). Commands use normal client configuration and authentication:

```sh
codex --no-daemon exec --json --ephemeral --sandbox workspace-write \
  --skip-git-repo-check -C <case-root> - < <prompt-file> > <rollout-file>

claude -p --output-format stream-json --verbose \
  --allowedTools Read,Glob,Grep,Write,Edit < <prompt-file> > <rollout-file>
```

The Claude command is the unavailable native-client probe, not an additional successful behavioral run. Guided Codex transcripts must show a completed read command whose output contains the actual new skill, rather than relying on an agent claiming to have read it.

The system skill-creator `quick_validate.py` reports `Skill is valid!`. Additional assertions confirm one exact copy of the design's base paragraph, propagation into every correction including continued subagents, acceptance using evidence in the existing SDD cycle, and absence of private paths and held-out example markers in the skill. The skill adds no executable scripts, hooks, dependencies or invocation restriction.

The saved rule requires the full base paragraph in initial executor/reviewer assignments and every correction, including continued subagents, together with the approved specification and plan paths. Acceptance uses the approved specification and evidence of required checks; omissions return to the existing SDD correction cycle without an additional review or new cycle.
