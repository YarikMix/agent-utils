---
name: typescript-native-lsp
description: Use when navigating TypeScript or JavaScript symbols, inspecting types or errors, exploring call hierarchies, or explicitly renaming a symbol with the installed native TypeScript MCP tools.
---

# TypeScript native LSP

Use the installed `typescript_native_lsp` MCP tools for semantic questions about a TypeScript or JavaScript project. Text search can locate a candidate symbol, but `definition` and `references` establish where it resolves and where it is used; `rename` applies a requested symbol rename across the project. Tool names may have a host-added prefix.

Pass an absolute source-file path. `line` and `character` are zero-based; `character` counts UTF-16 code units, so text after an emoji needs two units for that emoji. Use a position inside the intended identifier. Returned locations and diagnostic positions use the same convention; state the convention if presenting positions to the user.

Choose the tool for the question:

- `hover` for types and JSDoc; `definition` for the resolved declaration; `references` for usages across the project (including the declaration).
- `outline` for symbols in one file; `workspace_symbols` to locate a symbol in the project selected by `file`; `implementations` for interface or abstract declarations; `inlay_hints` for inferred types in a line range.
- `prepare_call_hierarchy` for a callable item, followed by `incoming_calls` for callers or `outgoing_calls` for callees. Pass its returned opaque `item_id` with a file from the **same project**. IDs cannot be reused across projects or sessions and may expire after file changes or a server restart. On an invalid or expired ID, prepare the item again in the target project, then retry traversal. Report the tool error if recovery fails.
- `diagnostics` after editing a file to inspect that file's current errors and available quick fixes. It does not replace the project's own typecheck and tests. Quick fixes are returned as data; apply none unless the user asks for the change.

`rename` writes to affected files. Call it only when the user explicitly requests a symbol rename; use the symbol's position and requested new name instead of textual find-and-replace. Inspect the resulting diff, then run the project's available typecheck and relevant tests. Navigation requests stay read-only.

If a relevant dependency edit is not reflected immediately, retry the affected read after a short delay; dependency updates can take up to about two seconds. Do not treat an MCP error as an empty result. The MCP server uses a global native TypeScript 7+ compiler, which can differ from the project's compiler and diagnostics.
