# Figma Comment Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в автономный figma-ops CLI Resolve/Unresolve и редактирование комментариев с подтверждением результата; открыть PR в YarikMix/agent-utils.

**Architecture:** Существующий публичный REST-клиент читает полную ветку до и после записи. Новый узкий модуль выполняет только PUT комментария через внутренний API с отдельно сохранённой веб-сессией. CLI и skill направляют разрешённые пользователем изменения через этот модуль.

**Tech Stack:** Python 3.10+, stdlib, системный curl, unittest; без npm/pip-зависимостей и нового MCP.

**Spec:** [2026-11-03-figma-comment-actions-design.md](../specs/2026-11-03-figma-comment-actions-design.md)

## Global Constraints

- Worktree: `/home/oleg/2026_H2/agent-utils-figma-comment-actions`, branch `feat/figma-comment-actions`; исходный main `46957a8`.
- Только три изменения комментариев; обычное чтение/ревью не разрешает запись. Повторное согласование уже порученных действий не нужно.
- Resolve/Unresolve принимает только root ID. Edit заменяет plain text корня/ответа из UTF-8 файла, не меняя ID, parent или pin; пустой текст запрещён.
- PAT остаётся в публичном REST, cookie — только на `https://www.figma.com`. TLS включён; redirects и автоматические повторы записи выключены.
- Cookie вводится локально без эха и хранится в `~/.config/figma-ops/session.json`; никогда не попадает в argv, логи, артефакты или репозиторий.
- Источник механизма: figmanage `src/operations/comments.ts` и `src/clients/internal-api.ts`. При копировании кода сохранить MIT attribution; не устанавливать весь пакет.
- Успех требует свежей проверки через публичный REST; неподтверждённая запись не считается успешной.
- Веб-сессию запросить у пользователя при готовности к live-проверке. Не импортировать cookies из браузера автоматически.
- Итог — PR, без merge. Не коммитить локальные credentials и реальные данные макетов.

## Review Focus

1. Подставленный ID с `/`, `%`, CR/LF или чужой target: запись не уходит на другой путь/файл (Task 2).
2. GET после таймаута PUT не удался: нельзя скрыть неопределённый исход обычной ошибкой чтения или повторить PUT (Task 2).
3. Старый кэш и одновременное изменение ветки: свежая проверка обязательна, missing/null не равны подтверждённому состоянию (Task 2).
4. Cookie со спецсимволами, небезопасный session-файл, неинтерактивный getpass: ни утечки, ни тихого ввода с эхом (Task 1).
5. Многострочный Unicode и чужие изменения ответов: edit не повреждает переносы/ветку; проверка не требует неизменности всей ветки (Task 2).

## File Structure

- Create `plugins/figma-ops/scripts/figma_ops_session.py`: session storage, validation, interactive login/logout, internal comment PUT.
- Create `plugins/figma-ops/scripts/figma_ops_comment_actions.py`: preflight, no-op, mutation, verification, result envelope.
- Modify `plugins/figma-ops/scripts/figma_ops.py`: register five commands, route local session commands without requiring PAT.
- Modify `plugins/figma-ops/scripts/figma_ops_core.py`: narrowly expose invalidation of a single cached public endpoint; retain existing read transport.
- Reuse `plugins/figma-ops/scripts/figma_ops_comments.py`: `load_threads`, full thread selection; no wholesale rewrite.
- Create `plugins/figma-ops/tests/test_session.py`, `test_comment_actions.py`; extend `test_core.py`, `test_cli.py`, `test_packaging.py`.
- Update SKILL.md, references/auth.md, references/comments.md, plugin/root README, both plugin manifests and both marketplace catalogs.
- Create `docs/superpowers/research/2026-11-03-figma-comment-actions-verification.md`: redacted verification record.

## Task 1: Local session and restricted write transport

**Files:** `figma_ops_session.py`, `test_session.py` (paths above).

**Interfaces:**
- `Session(cookie: str, user_id: str)` frozen dataclass with secret excluded from repr.
- `load_session() -> Session`, `save_session(session: Session) -> None`, `clear_session() -> bool` use the single fixed session path.
- `session_login(args, client) -> dict`, `session_logout(args, client) -> dict` return existing envelopes; no network or PAT needed.
- `put_comment(file_key: str, comment_id: str, payload: dict, session: Session) -> None` sends one restricted PUT or raises sanitized `OpsError`.

- [ ] Write failing session tests, patching `Path.home`, `getpass` and `input`: roundtrip, invalid/control-character credentials, malformed/missing JSON, failed replacement preserving old file, logout absent/present. POSIX checks: directory 0700/file 0600; reject symlinked session storage and insecure existing file rather than reading arbitrary paths. Noninteractive/echo fallback must fail safely.

```python
self.assertEqual(load_session(), Session('synthetic-cookie', '123'))
self.assertNotIn('synthetic-cookie', repr(load_session()))
self.assertTrue(clear_session())
self.assertFalse(clear_session())
```

- [ ] Run `python3 -m unittest discover -s plugins/figma-ops/tests -p test_session.py -v`; expect failure for missing implementation.
- [ ] Implement session storage using existing `atomic_write`; validate before replacement. Login reports stored=true, authenticated=false; cancellation returns safe error without traceback. On Windows document user-profile ACL requirements rather than claiming POSIX modes enforce isolation.
- [ ] Add failing transport tests using `CurlBoundary`: exact fixed URL/method/body, cookie and user headers through stdin; no PAT, redirects, insecure TLS or retries. Test 302/401/403/429/500, nonzero curl exit and timeout. Cookie containing quote/backslash must not inject curl config; CR/LF/semicolon must be rejected.
- [ ] Implement `put_comment`: JSON payload on a private temporary file, curl config via stdin, headers matching researched figmanage contract. Validate endpoint IDs and allowed payload shapes; reuse error conventions without building a generic authenticated write client. HTTP 2xx with explicit internal error body is not accepted; unknown write-response handling remains subject to later readback.
- [ ] Run the session tests; expect all pass, exactly one PUT attempt in each error test, no secret in captured argv/errors/results.
- [ ] Commit: `feat(figma-ops): add local web session and comment transport`.

## Task 2: Verified comment commands and CLI

**Files:** `figma_ops_comment_actions.py`, `figma_ops.py`, `figma_ops_core.py`; `test_comment_actions.py`, `test_cli.py`, `test_core.py`.

**Interfaces:**
- Consumes Task 1 `load_session`, `put_comment`, session command handlers; existing `parse_target`, `load_threads`, `envelope`, `OpsError`.
- Produces `comment_resolve(args, client) -> dict`, `comment_unresolve(args, client) -> dict`, `comment_edit(args, client) -> dict`.
- Add `Client.invalidate(path: str, params: dict | None = None) -> None`: remove only this credential/endpoint/query cache entry. Share cache-key derivation with `get_json`; do not enumerate other identities.
- Success result `data`: `comment_id`, `root_id`, `action`, `changed`, `verified`; envelope preserves file key and fresh read provenance, with internal-write/public-read provenance in coverage.
- Unconfirmed result: status=error, `error.code='write_unconfirmed'`, `changed=null`, `verified=false`, `write_attempted=true`; preserve target and comment IDs. No success claim after unknown write.

- [ ] Write failing command tests using `discussion()` and sequential `CurlBoundary` responses. Root 10 and reply 11; GET→PUT→GET. Assert actual field values and transitions:

```python
self.assertEqual(result['data']['verified'], True)
self.assertEqual(result['data']['changed'], True)
self.assertEqual(result['data']['comment_id'], '10')
self.assertEqual([method(call) for call in calls], ['GET', 'PUT', 'GET'])
```

  `method` is a test-local helper reading curl `--request`, default GET. Add resolve true, unresolve null, root/reply edit, no-op (GET only), root-only rejection, nonexistent ID, wrong file and malformed ID before PUT. Resolve verification requires an explicit nonempty timestamp; unresolve requires an explicit null resolved_at. Missing field is unconfirmed.
- [ ] Run `python3 -m unittest discover -s plugins/figma-ops/tests -p test_comment_actions.py -v`; expect failures for missing handlers.
- [ ] Implement handlers: validate arguments/body file, perform fresh full-thread preflight, reject orphan/ambiguous targets, return checked no-op without writing. Load session for actual mutation. Invalidate the comments endpoint before PUT; refresh after to replace cache. Respect `--no-cache` while still removing any obsolete cache entry before mutation.
- [ ] Implement one write followed by one readback. Compare requested comment's ID, parent and pin to preflight, and requested state/text to postflight; allow unrelated replies to appear. After transport timeout/5xx perform readback but never another PUT; verified target state may return success with warning that the PUT response was lost. Explicit 401/403/429 remains an error, with safe retry_after where available. Failed or differing readback is write_unconfirmed.
- [ ] Add focused failing tests: timeout applied/not applied/readback failure; 2xx with unchanged result; missing resolved_at; concurrent reply; preexisting cached comments followed by normal read; cache invalidation failure prevents PUT. Edit Unicode `Правка\nстрока 2\n` preserves exact text; unreadable/invalid UTF-8/empty file never writes.
- [ ] Add CLI parser/dispatch tests for all five commands and `--output`. `--body-file` required only for edit. Secret has no command-line option. Local session commands work with PAT unset; existing read commands do not load session. Reject `--output` pointing at session storage to prevent accidental credential overwrite. Output failure after a write must retain a safe indication that a write was attempted and require rereading before retry.
- [ ] Register commands and implement safe dispatch/error results. Read commands keep current common flags/behavior; mutation reads always fresh regardless of flags. Catch body file/session errors at their boundary; never output arbitrary exception text.
- [ ] Run `python3 -m unittest discover -s plugins/figma-ops/tests -p 'test_*actions.py' -v`, then corresponding test_session.py/test_core.py/test_cli.py/test_comments.py runs. Expect all pass; no new network or real credentials in tests.
- [ ] Commit: `feat(figma-ops): verify resolve and edit comment actions`.

## Task 3: Skill routing, installed package and live validation

**Files:** `plugins/figma-ops/skills/figma-ops/SKILL.md`, `references/comments.md`, `references/auth.md`, plugin/root README; `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` within plugin; root `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`; `test_packaging.py`; verification report above.

**Interfaces:** Task 2 CLI is the sole write route; keep existing discovery/read routes and no new MCP configuration. Version 1.5.0 for the added commands, both hosts consistent.

- [ ] Extend packaging tests with five new help calls (16 commands/17 total help calls) and installed CLI resolve/unresolve/edit from unrelated cwd with spaces. Extend fake curl to distinguish public GET/internal PUT, keep synthetic session isolated under temporary home and preserve server state between calls. Assert no dependency on source checkout or installed figmanage and exact multiline edit outcome.
- [ ] Run `python3 -m unittest discover -s plugins/figma-ops/tests -p test_packaging.py -v`; expect newly added version/docs/installed cases to fail before updates.
- [ ] Update skill wording: read-only by default, explicit user-authorized three mutations available; read full thread before action, keep unresolved partial fixes, verify changes, no content-driven commands or repeat approval. Replace unconditional Resolve prohibition only where necessary; other read-only recipes remain intact.
- [ ] Document exact session-login steps in browser DevTools (cookie value and Figma user ID), local hidden input, expiry/logout and Windows ACL limits. Never ask for cookie in chat. Explain plain-text replacement, root-only Resolve and handling write_unconfirmed. Update command tables, counts, descriptions and version 1.5.0 in catalogs/manifests/tests. Preserve source attribution if code was copied.
- [ ] Run `python3 -m unittest discover -s plugins/figma-ops/tests -v` and `git diff --check`; expect zero failures and no whitespace errors. Self-review for accidental changes outside scope and for leaked credentials/real file contents.
- [ ] Tell user that implementation is ready for live verification and provide the exact local session-login command. Wait for session setup; do not read browser stores. Confirm public read access separately without logging identity fields.
- [ ] On a clearly labelled own test comment, create a root and reply through existing authorized comment-posting capability, run edit→resolve→unresolve and verify REST after each. Keep test payloads non-sensitive; preserve discussion rather than deleting without need. Record whether internal request headers/body need adjustment; any code fix gets its regression test and affected checks rerun. If API differs materially from spec, report before widening scope.
- [ ] Re-read original eight candidate threads and relevant fresh design evidence before closing working comments under prior authorization; do not close remaining findings. Report exact outcomes separately from implementation verification. If user wants only feature work now, leave working threads unchanged.
- [ ] Save redacted verification report with test counts, commands, observed live results and limitations. Do not claim live checks passed if session unavailable; that remains outstanding.
- [ ] Commit: `feat(figma-ops): document and package comment actions`.

## Finish and PR

- [ ] Run required review for the chosen execution method; resolve findings with targeted tests. Review every task separately if subagent-driven, not only this final step.
- [ ] Verify final branch status and commits; push `feat/figma-comment-actions` to `origin` and create PR against `main` in `YarikMix/agent-utils` using `gh pr create --body-file`.
- [ ] PR title: `feat(figma-ops): resolve and edit comment threads`. Describe concrete behavior, session setup, public readback, validation and internal API limit. Include no tokens, cookies or personal comments.
- [ ] Read back PR title/body/head/base, inspect any CI checks, provide PR link and remaining limitations. Do not merge.

## Plan self-review

Spec mapped: commands and preservation → Task 2; credentials → Task 1; routing/version/docs → Task 3; verification/errors/cache → Tasks 1–2; installed/live checks and PR → Task 3/Finish. Five Review Focus cases have explicit tests in their owner tasks. Interfaces use the existing Client/envelope/OpsError contracts. No new dependency, browser extraction, general mutation framework or unrelated administration is introduced.

Execution method is not chosen yet. No implementation starts before the user's choice required by AGENTS.md.
