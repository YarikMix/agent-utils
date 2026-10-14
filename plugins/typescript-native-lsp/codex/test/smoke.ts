/** Imported pool smoke test with assertions. Run: npm run smoke */
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { devNativeBinary, temporaryProject } from "./support.ts"
import { TypeScriptPool } from "../src/pool.ts"
import { resolveTscBinary } from "../src/resolve-binary.ts"

process.env.TSC_PATH = devNativeBinary()
const binary = await resolveTscBinary()
console.error(`Using TypeScript binary: ${binary}`)

const pool = new TypeScriptPool(async () => binary)
const original = await readFile(new URL("sample.ts", import.meta.url), "utf8")
const project = await temporaryProject({ "sample.ts": original })
const testFile = join(project.root, "sample.ts")

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
  assert.deepEqual(diagnostics.filter(d => d.severity === "error"), [])
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

  // 5. Rename writes only the disposable project copy.
  console.error(`\n--- rename (createWorkflow -> buildWorkflow, line 37 char 9) ---`)
  const result = await pool.rename(testFile, 37, 9, "buildWorkflow")
  assert.ok(result.editCount >= 2)
  assert.deepEqual(result.files.map(item => item.file), [testFile])
  const renamed = await readFile(testFile, "utf8")
  assert.match(renamed, /function buildWorkflow\(/)
  assert.match(renamed, /const workflow = buildWorkflow\(/)
  assert.match(renamed, /buildWorkflow as createWorkflow/)
  assert.equal(await readFile(new URL("sample.ts", import.meta.url), "utf8"), original)
  console.log(`Rename edits applied to temporary copy: ${result.editCount}`)

  // 6. Inlay hints (lines 49-64 — example usage section with inferred types)
  console.error(`\n--- inlay hints (lines 49-64) ---`)
  const hints = await pool.inlayHints(testFile, 49, 64)
  assert.ok(hints.length > 0)
  assert.ok(hints.some(hint => hint.kind === "type" || hint.kind === "parameter"))
  console.log(`Inlay hints: ${hints.length}`)
  for (const h of hints) {
    console.log(`  ${h.line}:${h.character} ${h.kind}: ${h.text}`)
  }

} finally {
  try { await pool.shutdown() } finally { await project.dispose() }
}
console.error("\nDone.")
