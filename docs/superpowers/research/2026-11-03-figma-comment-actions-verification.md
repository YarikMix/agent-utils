# Figma comment actions — verification

## Automated checks

- Baseline: 317 tests passed before implementation.
- Session storage RED: 7 failures for missing session support; GREEN: 7 passed.
- Internal PUT RED: 5 failures for missing transport; GREEN: 12 session/transport tests passed.
- Comment commands RED: 17 failures for missing actions; GREEN: 17 passed.
- Cache invalidation RED: missing invalidation assertion; GREEN: 35 core tests passed.
- Packaging RED: version 1.5.0 missing in both host manifests; GREEN: 5 packaging tests passed.
- Complete suite: `python3 -m unittest discover -s plugins/figma-ops/tests`: **350 tests passed**.
- Installed-copy verification: all 16 command help pages plus top-level help; isolated cwd with spaces, synthetic session and stateful fake Figma server. Edit preserves Unicode/CRLF, Resolve and Unresolve persist the expected state, replies remain intact.
- `git diff --check`: passed.

## Skill application checks

Fresh-context baseline read only existing SKILL.md/comments/auth: no documented
mutation command or web-session procedure could be found; existing read-only
review guidance correctly avoided writes.

After the documentation update a fresh-context application check selected
`comment-edit` and `comment-resolve`, exact file/comment IDs and full-thread
preflight, local hidden session input, verified readback/no-op handling and no
blind retry after timeout. The read-only scenario still avoided mutations.
No blocking guidance gap was reported. These checks did not call live Figma.

## Live verification

**Pending web-session setup by the user.** No live edit/Resolve/Unresolve result
is claimed. The current CLI PAT is configured; no cookie is copied from browser
storage automatically. The user was given the local `session-login` command.

The internal PUT path, headers and payload were researched from figmanage:

- https://github.com/dannykeane/figmanage/blob/main/src/operations/comments.ts
- https://github.com/dannykeane/figmanage/blob/main/src/clients/internal-api.ts

The Python implementation is independently written against that observed
protocol; no figmanage package or TypeScript implementation is bundled.
The internal API can change independently of the public REST API. Synthetic
transport tests prove the client behavior, not that Figma accepts this protocol.

## Review

Fresh whole-branch review used gpt-6-astra (high), range `46957a8..8d363a6`.
One Important finding: malformed id/parent_id in post-write readback raised an
uncaught TypeError, losing the uncertain-write receipt. Reproduced with two
RED regressions; fixed ID validation at the shared comment parser boundary.
Both regressions and the full 350-test suite pass. No Critical or Minor findings.

Review also confirmed that readback-cache ENOSPC becomes write_unconfirmed.
Live internal-API acceptance remains pending. Native Windows ACL behavior was
not exercised on Linux; the platform limit is documented. Code review was run
while waiting for session setup; any later live-protocol correction must receive
its own RED→GREEN regression and full-suite verification.
