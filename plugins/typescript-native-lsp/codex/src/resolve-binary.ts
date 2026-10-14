import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, open, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  versionTimeoutMs?: number
}

const GUIDANCE = "Install TypeScript 7+ globally and add tsc to PATH, or set TSC_PATH to its absolute native binary path."

/** Resolve only the global compiler, then verify its version in an owned process. */
export async function resolveTscBinary(options: ResolveOptions = {}): Promise<string> {
  const binary = await discoverTscBinary(options)
  await probeVersion(binary, options.env ?? process.env, options.versionTimeoutMs ?? 5000)
  return binary
}

/** Discovery is separate so foreign npm launcher fixtures need never be executed. */
export async function discoverTscBinary(options: ResolveOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (env.TSC_PATH) {
    try {
      if (!isAbsolute(env.TSC_PATH)) throw new Error("TSC_PATH must be absolute")
      return await nativeBinary(env.TSC_PATH, platform)
    } catch (error) {
      throw new Error(`Invalid TSC_PATH: ${message(error)}. ${GUIDANCE}`, { cause: error })
    }
  }

  const path = Object.entries(env).find(([key]) => platform === "win32" ? key.toLowerCase() === "path" : key === "PATH")?.[1] ?? ""
  const names = platform === "win32" ? ["tsc.exe", "tsc.cmd", "tsc", "tsc.ps1"] : ["tsc"]
  for (const entry of path.split(platform === "win32" ? ";" : ":")) {
    const rawDirectory = entry.replace(/^"(.*)"$/, "$1")
    // Empty/relative entries must not silently select a checkout compiler.
    if (!isAbsolute(rawDirectory)) continue
    const normalizedDirectory = normalize(rawDirectory)
    let directory: string
    try { directory = await realpath(normalizedDirectory) } catch { continue }
    const localBin = /(?:^|[\\/])node_modules[\\/]\.bin[\\/]?$/i
    if (localBin.test(normalizedDirectory) || localBin.test(directory)) continue
    for (const name of names) {
      const launcher = join(directory, name)
      try { await stat(launcher) } catch { continue }
      try {
        return await nativeFromLauncher(launcher, platform, arch)
      } catch (error) {
        // Respect PATH precedence: an incompatible first tsc is actionable.
        throw new Error(`Could not resolve TypeScript 7+ from PATH launcher "${launcher}": ${message(error)}. ${GUIDANCE}`, { cause: error })
      }
    }
  }
  throw new Error(`Could not find TypeScript 7+ on PATH. ${GUIDANCE}`)
}

/** Read a standard launcher as data; never run Node, cmd, PowerShell or a shell. */
async function nativeFromLauncher(launcher: string, platform: NodeJS.Platform, arch: string): Promise<string> {
  const target = await realpath(launcher)
  if (await hasNativeHeader(target, platform)) return nativeBinary(target, platform)

  let script = target
  if (!/[\\/]typescript[\\/]bin[\\/]tsc$/.test(script)) {
    const file = await open(target, "r")
    let text: string
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      text = buffer.subarray(0, bytesRead).toString("utf8")
    } finally { await file.close() }
    const reference = text.match(/["'](?:%dp0%|%~dp0|\$basedir|\$\{basedir\}|\$PSScriptRoot)[\\/]((?:\.\.[\\/])?(?:lib[\\/])?node_modules[\\/]typescript[\\/]bin[\\/]tsc)["']/i)?.[1]
    if (!reference) throw new Error("tsc is not a standard TypeScript npm launcher or native executable")
    script = await realpath(resolve(dirname(target), reference.replaceAll("\\", "/")))
  }
  if (!/[\\/]typescript[\\/]bin[\\/]tsc$/.test(script)) throw new Error("npm launcher does not target typescript/bin/tsc")
  const packageRoot = dirname(dirname(script))
  const installationRoot = await realpath(dirname(packageRoot))
  const nativePackage = `@typescript/typescript-${platform}-${arch}`
  // Only package-local or hoisted global dependencies belong to this installation.
  // Node's normal ancestor lookup could silently fall back to a checkout package.
  for (const nativeRoot of [join(packageRoot, "node_modules", nativePackage), join(dirname(packageRoot), nativePackage)]) {
    try { await stat(join(nativeRoot, "package.json")) } catch { continue }
    const canonicalRoot = await realpath(nativeRoot)
    requireInInstallation(installationRoot, canonicalRoot)
    const binary = await realpath(join(canonicalRoot, "lib", platform === "win32" ? "tsc.exe" : "tsc"))
    requireInInstallation(installationRoot, binary)
    return nativeBinary(binary, platform)
  }
  throw new Error(`Global TypeScript installation is missing native package ${nativePackage}`)
}

/** Automatic discovery must stay physically inside this global npm dependency tree. */
function requireInInstallation(installationRoot: string, target: string): void {
  const path = relative(installationRoot, target)
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Native TypeScript target "${target}" is outside the global installation "${installationRoot}"`)
  }
}

/** Validate native ownership: scripts/shims would create an unowned compiler child. */
async function nativeBinary(path: string, platform: NodeJS.Platform): Promise<string> {
  let binary: string
  try { binary = await realpath(path) } catch { throw new Error(`binary "${path}" does not exist`) }
  if (!(await stat(binary)).isFile()) throw new Error("binary must be a file")
  if (platform !== "win32") {
    try { await access(binary, constants.X_OK) } catch { throw new Error("binary is not executable") }
  }
  if (!await hasNativeHeader(binary, platform)) throw new Error("binary must be a native executable, not a Node/shell/npm wrapper")
  return binary
}

/** Recognize the host executable format without reading an entire compiler. */
async function hasNativeHeader(path: string, platform: NodeJS.Platform): Promise<boolean> {
  const file = await open(path, "r")
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead < 4) return false
    if (platform === "win32") {
      if (bytesRead < 64 || header.toString("ascii", 0, 2) !== "MZ") return false
      const signature = Buffer.alloc(4)
      await file.read(signature, 0, 4, header.readUInt32LE(60))
      return signature.equals(Buffer.from([0x50, 0x45, 0, 0]))
    }
    if (platform === "darwin") return [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE(0))
    return header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  } finally { await file.close() }
}

/** A bounded direct version probe. Timeout kills and reaps only this child. */
async function probeVersion(binary: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"], shell: false })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 8192) })
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 8192) })
    child.once("error", error => {
      clearTimeout(timer)
      reject(new Error(`TypeScript 7+ version probe failed: ${message(error)}. ${GUIDANCE}`, { cause: error }))
    })
    child.once("close", code => {
      clearTimeout(timer)
      if (timedOut) { reject(new Error(`TypeScript version probe timed out after ${timeoutMs} ms. ${GUIDANCE}`)); return }
      const version = stdout.match(/^Version (\d+)\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\s*$/m)
      if (code !== 0 || !version || Number(version[1]) < 7) {
        reject(new Error(`Expected TypeScript 7+ native compiler; version probe returned ${JSON.stringify((stdout || stderr).trim())} (exit ${code}). ${GUIDANCE}`))
        return
      }
      resolve()
    })
  })
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
