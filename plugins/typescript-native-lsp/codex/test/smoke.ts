/** Imported pool smoke test with assertions. Run: npm run smoke */
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { devNativeBinary } from "./support.ts"
import { TypeScriptPool } from "../src/pool.ts"
import { resolveTscBinary } from "../src/resolve-binary.ts"

process.env.TSC_PATH = devNativeBinary()
const binary = await resolveTscBinary()
console.error(`Using TypeScript binary: ${binary}`)

const pool = new TypeScriptPool(async () => binary)
const testFile = fileURLToPath(new URL("sample.ts", import.meta.url))

try {
  // 1. Hover + definition
  console.error(`\n--- hover (createWorkflow, line 37 char 9) ---`)
  const hover = await pool.hoverWithDefinition(testFile, 37, 9)
  console.log("Hover:", hover.hover?.split("\n")[0])
  console.log("Definition:", hover.definition)
  assert.match(hover.hover ?? "", /createWorkflow/)
  assert.ok(hover.definition)
  const numericHover = await pool.hoverWithDefinition(testFile, 12, 4)
  assert.match(numericHover.hover ?? "", /number/)

  // 2. Diagnostics with fixes
  console.error(`\n--- diagnostics ---`)
  const { diagnostics, actions } = await pool.diagnosticsWithFixes(testFile)
  console.log(`Errors/warnings: ${diagnostics.length}`)
  for (const d of diagnostics) {
    console.log(`  ${d.line}:${d.character} ${d.severity}: ${d.message}`)
  }
  console.log(`Code actions: ${actions.length}`)
  for (const a of actions) {
    console.log(`  ${a.title} (${a.kind}) — ${a.edits.length} edit(s)`)
  }

  // 3. References for createWorkflow
  console.error(`\n--- references (createWorkflow, line 37 char 9) ---`)
  const refs = await pool.references(testFile, 37, 9)
  assert.ok(refs.length >= 2)
  console.log(`Found ${refs.length} reference(s):`)
  for (const ref of refs) {
    console.log(`  ${ref.file}:${ref.line}:${ref.character}`)
  }

  // 4. Outline
  console.error(`\n--- outline ---`)
  const symbols = await pool.outline(testFile)
  assert.ok(symbols.some(symbol => symbol.name === "createWorkflow"))
  console.log(`Top-level symbols: ${symbols.length}`)
  for (const sym of symbols) {
    console.log(`  ${sym.kind} ${sym.name} (line ${sym.line})`)
    for (const child of sym.children) {
      console.log(`    ${child.kind} ${child.name} (line ${child.line})`)
    }
  }

  // 5. Rename (dry run — just see what edits would be produced)
  console.error(
    `\n--- rename (createWorkflow -> buildWorkflow, line 37 char 9) ---`,
  )
  const renameEdits = await pool.rename(testFile, 37, 9, "buildWorkflow")
  assert.ok(renameEdits.length >= 2)
  assert.ok(renameEdits.some(edit => edit.newText === "buildWorkflow"))
  assert.ok(renameEdits.every(edit => edit.newText.startsWith("buildWorkflow")))
  console.log(`Rename edits: ${renameEdits.length}`)
  for (const e of renameEdits) {
    console.log(
      `  ${e.file}:${e.startLine}:${e.startCharacter} -> ${e.endLine}:${e.endCharacter}`,
    )
  }

  // 6. Inlay hints (lines 49-64 — example usage section with inferred types)
  console.error(`\n--- inlay hints (lines 49-64) ---`)
  const hints = await pool.inlayHints(testFile, 49, 64)
  console.log(`Inlay hints: ${hints.length}`)
  for (const h of hints) {
    console.log(`  ${h.line}:${h.character} ${h.kind}: ${h.text}`)
  }

} finally {
  await pool.shutdown()
}
console.error("\nDone.")
