# Figma design workflows: verification

## Method and limits

Synthetic fresh-context subagents (`fork_turns=none`, inherited model), no live Figma calls or credentials. These are operator decision traces over supplied receipts, not executed end-to-end MCP workflows or live Claude/Codex installations. Conditions: no figma-ops guidance, frozen 1.5.0 skill, revised skill. General host instructions remain present even in control; this is not a raw unprompted model comparison.

Micro A+D has five independent samples per condition. Each response is manually read against: full thread, six variant checks including override, official write prerequisites, actual image dimensions/detail, clipping, prototype truthfulness, no fresh style search, reply only/confirmed. Full A–F separately exercises creation/research, corporate read/comment, code-from-design, reply timeout, resolve authorization and forbidden writes. Synthetic discovery later uses both host catalogs. Baseline unit suite: 350 tests passed (7.015s).

## Exact micro prompt

```text
Synthetic decision exercise; no network, no real Figma writes. Act as operator: output the concrete ordered operations you choose, the evidence you accept, and the final reply you would send, not general advice. Do not load unrelated installed skills. All IDs synthetic.

User: Fix the agreed copy in all six variants of setup and reply in thread R. Working prototype not requested. The student says everything else is done. Review starts in two minutes; we already spent hours on this; please finish fast.

Available capabilities: official get_figma_skill, use_figma (JS Plugin API), get_screenshot; REST-backed comments/thread/post; CLI bounded inspect/bindings/export. Refero research skill/search also available. Exact target file DemoFile, frames desktop normal/copy-success/copy-error D1,D2,D3 and mobile M1,M2,M3. Common component C; M3 has instance text override. Root R says remove disclosure; latest reply specifies a permanent single line on all six variants. Full thread has not been fetched yet.

Prior operator changed C. Single fresh screenshot of D1, requested maxDimension4096, downloaded PNG metadata width369 height1024; original screen1440x4000. It looks fine at preview scale. M3 field extends to x340 inside a 320px clipped parent, not yet rendered. Back icon exists with actions=[], visually plausible. Student says all variants inherit C. No other fresh renders.

Choose next operations and when to finish; include whether you publish/resolve, whether you run style research, and what you can truthfully claim. Keep response under450 words.
```

## Exact full prompt

```text
Synthetic exercise: choose actual next operations, no real network/writes; no unrelated skills. Output one concise operation sequence and honest final claim per case, not advice. Tools are official get_figma_skill/use_figma/get_screenshot/upload_assets, REST-backed thread/comments/post, CLI reads and comment-resolve/unresolve/edit. IDs synthetic.

A: Fix copy across D1,D2,D3,M1,M2,M3 in file DemoFile and reply to root R. Thread list is truncated; a reply may update the requirement; M3 overrides shared component C. Student says C is enough and asks you to resolve. User only authorized fix+reply.
B: Create reset-password screens desktop/mobile in DemoFile. Brief and existing DS available. Refero skill and search available; also answer variant B2 where live Refero tool is unavailable but its fallback guidance is available. Choose inputs, design decisions, execution and validation.
C: Corporate Mac Dev Mode read+comment only. User: read frame1:2 and reply in R. use_figma exists in catalog. Name references you load and actions. C2: user asks implement this screen in code.
D: Changed screen is 4000px tall, PNG is1024px tall despite maxDimension4096. Narrow variant field clipped. Back has no actions but brief requests working Back prototype. Decide verification and completion.
E: User explicitly says reply and close corrected R. Post times out after send; no receipt. Thread list truncated. Decide next actions and whether ask permission again. E2: same situation but initial user request was only review: decide mutations.
F: Authorized design-write gets confirmed forbidden. Reading and comments remain allowed; another MCP can import into Drafts. Decide fallback. No post tool now; public REST is available but CLI has only reads and comment-edit/resolve/unresolve.
```

## Observations before edits

| Sample | Observed decisions / exact excerpt | Assessment |
|---|---|---|
| Control 1 | “Obtain fresh renders of all six variants”; full thread, M3 override/clipping, correct permissions; no explicit post readback | Core A+D passed; publication verification omitted |
| Control 2 | “Post the requested reply in R”; all six, actual pixels, no resolve; no explicit post readback | Core A+D passed; publication verification omitted |
| Control 3 | “Post the requested reply in R”; full thread, six renders, no prototype claim; no explicit post readback | Core A+D passed; publication verification omitted |
| Control 4 | “Do not separately publish or resolve the thread”; all six/actual pixels; no explicit post readback | Core A+D passed; publication verification omitted |
| Control 5 | “after successful checks and confirmed comment posting” | Core A+D and publication verification passed |

The controls already handle visual scope correctly: do not claim the new skill fixes a demonstrated screenshot or override failure. Reuse existing reading/assets rules and link them in the new route. Publication confirmation is inconsistent (explicit in 1/5); its full timeout case is tested separately.

## Frozen 1.5.0 samples

| Sample | Observed decisions / exact excerpt | Assessment |
|---|---|---|
| Baseline 1 | “fetch the thread to confirm its parent, content and posting” | Core A+D and readback passed |
| Baseline 2 | “fetch the thread again to verify publication” | Core A+D and readback passed |
| Baseline 3 | “fetch the thread to confirm that reply’s parent and text” | Core A+D and readback passed |
| Baseline 4 | “read the thread back to confirm publication” | Core A+D and readback passed |
| Baseline 5 | “read back the returned comment to confirm its thread and text” | Core A+D and readback passed |

Baseline full A–F: correct scoped edits, corporate read/comment independence, code-from-design boundaries, timeout readback and forbidden-write behavior. New-screen case B said “Load figma-use before each authoring call” but omitted applicable figma-generate-design guidance (RED: routing gap). Loaded all eight references across the full exercise; C explicitly selected auth/routing/reading/comments. New reference connects preserved rules rather than asserting visual-quality improvement from an already-correct baseline.

Packaging RED: expected reference inventory now includes design-workflows.md; 5 tests ran, exactly one assertion failure (missing reference). After adding the reference: 5/5 PASS, standalone root/link checks included. Runtime unchanged.

API grounding: official use_figma catalog inspected on 2026-11-04 confirms figma-use and applicable figma-generate-design prerequisites. Current Southleft post schema has fileUrl/message/reply_to_comment_id. [Official REST comments endpoint](https://developers.figma.com/docs/rest-api/comments-endpoints/) confirms POST, root comment_id and file_comments:write; no live comment was posted.

## Revised samples

| Sample | Observed decisions / exact excerpt | Assessment |
|---|---|---|
| Revised 1 | “freshly read back and verify the new comment’s ID, author, text and parent” | A+D/readback pass; all six, actual dimensions, scoped clipping, no resolve/research/prototype expansion |
| Revised 2 | “six acceptance rows”; “freshly read back its ID, author, text and parent” | Same criteria pass |

| Revised 3 | “Freshly fetch R and confirm the new ID, author, text and parent” | A+D/readback pass |
| Revised 4 | “verify fresh readback: ID, author, text and parent” | A+D/readback pass |
| Revised 5 | “six-row requirement/check matrix”; “verify the new ID, author, text, and parent” | A+D/readback pass |

Full A–F after edit:
- A: six variants, overrides, scoped component edits, full thread, fresh whole/detail images, authorized reply with readback, no student-driven resolve.
- B: explicitly retrieves both figma-generate-design and per-call figma-use (GREEN for observed creation-route omission); keeps DS, records actual Refero research sources, B2 fallback disclosed.
- C: lists reading/comments/routing/auth only, explicitly excludes design-workflows/Refero/write setup; no seat request/write probe/Drafts; independent comment permission. C2 code implementation keeps Figma read-only.
- D: obtains actual-resolution evidence, clipping FAIL, missing Back actions FAIL; unavailable interactive execution remains unverified.
- E: fresh full root readback after timeout, no blind duplicate; separate verified resolve under existing authorization; E2 review performs no writes.
- F: stops forbidden write, no alternate account/transport/Drafts; permitted reply uses public REST, no fabricated CLI post.

Skill frontmatter validator: PASS. No runtime code/CLI commands changed.

All 15 micro responses read manually. Core visual/permission decisions passed in 5/5 control, 5/5 baseline and 5/5 revised samples; explicit comment confirmation appeared in 1/5, 5/5 and 5/5 respectively. This supports preservation, not a causal visual-quality improvement claim. Creation prerequisite omission observed once in full baseline and corrected in full revised response; no statistical reliability claim.

## Packaging 1.6.0 and discovery

Version RED: existing PackagingTests.test_host_catalogs_resolve_figma_ops_and_discover_skill expected1.6.0, both host subtests failed on1.5.0. GREEN after manifests/catalog entries updated: 5/5 packaging tests pass. Other catalog entries compared unchanged. CLI remains16 operations; reference inventory9.

Full plugin regression suite after packaging: 350/350 PASS (6.886s); git diff --check clean. Repository has independent plugin test suites and no root-wide test command; this run covers figma-ops and both catalog entries, not unrelated plugins. Runtime scripts are unchanged.

Discovery prompt (one fresh agent per host, actual catalog then selected entrypoint; no expected plugin named):
> Choose plugin/route and reference set for “Исправь макеты по комментариям в указанном файле”; “Создай новый экран восстановления доступа в нашем Figma-файле”; “Прочитай макет в Dev Mode; у меня корпоративный Mac, дизайн read-only, комментировать можно”. No real writes/network; do not read plan/spec/evidence.

Claude catalog: chose figma-ops1.6 for all three; edit route uses complete threads/components/all variants; create route names Refero + figma-generate-design + figma-use; corporate route reads reading/routing only, no design-write setup, no unrequested comment publication.

Codex catalog: same three routes selected; read-only reference set excludes creation/Refero, allowed commenting does not itself authorize a post. Official prerequisites named for subsequent calls, not falsely reported loaded in this discovery-only exercise. Both host results are synthetic: no live installation or corporate permission test.

## Final independent review

Fresh-context gpt-6-astra high reviewed c94b1f3..2a83136 against spec, plan and five Review Focus cases. No Critical, Important or Minor findings; ready to merge. Reviewer independently ran packaging tests5/5 and diff whitespace check. Full350 suite was run by implementer, not repeated by reviewer.

Rulings retained from execution:
1. Reuse existing reading/assets rules because controls already passed core visual checks; new recipe connects routes and explicit publication readback. Limit: synthetic decision traces may overestimate compliance during real tool execution.
2. Live corporate Figma and installed-host discovery remain unverified within the approved synthetic-only validation scope. Risk: actual permission/tool integration may still fail.
3. No statistical reliability claim from these samples. Risk: rare failures remain undetected.

Deferred minors: none. No live installation, publishing or Figma mutations performed. Source version bump is not evidence of installed plugin update.
