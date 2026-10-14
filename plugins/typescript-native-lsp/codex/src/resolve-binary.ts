import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const PLATFORM_PACKAGE = `@typescript/typescript-${process.platform}-${process.arch}`

/**
 * Resolves the TypeScript 7 native compiler installed for the current platform.
 * The native binary is required (not the Node wrapper) for stdio piping.
 *
 * @throws When the configured or installed native binary cannot be found.
 */
export function resolveTscBinary(): string {
  const envPath = process.env.TSC_PATH
  if (envPath) {
    if (!existsSync(envPath))
      throw new Error(
        `TSC_PATH is set to "${envPath}" but the file does not exist`,
      )
    return envPath
  }

  const binaryPath = join(
    dirname(
      createRequire(
        createRequire(import.meta.url).resolve("typescript/package.json"),
      ).resolve(`${PLATFORM_PACKAGE}/package.json`),
    ),
    "lib",
    process.platform === "win32" ? "tsc.exe" : "tsc",
  )
  if (existsSync(binaryPath)) return binaryPath

  throw new Error(
    [
      "Could not find the TypeScript 7 native compiler.",
      `Looked for package: ${PLATFORM_PACKAGE}`,
      `Expected binary: ${binaryPath}`,
      "Reinstall @zachsents/ts-mcp, or set TSC_PATH to the native binary path.",
    ].join("\n"),
  )
}
