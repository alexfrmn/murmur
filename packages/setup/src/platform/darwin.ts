import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServiceContext, ServiceSnapshot, ClientDetection, PlatformAdapter } from "../types.js";

export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;
export interface DarwinOptions {
  homeDir?: string; uid?: number; env?: NodeJS.ProcessEnv; run?: CommandRunner;
  applicationDirs?: string[];
  /** Fully replaces executable search roots, primarily for hermetic tests. */
  executableDirs?: string[];
}

const marker = "<!-- Managed by Murmur setup: darwin-v1 -->";
const launchctl = "/bin/launchctl";
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
}[c]!));
function absolute(value: string, name: string): string {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || path.normalize(value) !== value) {
    throw new Error(`darwin-invalid-absolute-path:${name}`);
  }
  return value;
}
function validate(ctx: ServiceContext) {
  for (const key of ["dataDir", "configPath", "storePath", "repoRoot", "nodePath", "logDir"] as const) {
    absolute(ctx[key], key);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(ctx.serviceName)) {
    throw new Error("darwin-invalid-service-name");
  }
  // The current daemon resolves both paths from DATA_DIR, ignoring STORE_PATH.
  // Refuse an inconsistent context instead of starting against the wrong DB.
  if (ctx.configPath !== path.join(ctx.dataDir, "agent-config.json") ||
      ctx.storePath !== path.join(ctx.dataDir, "murmur.db") ||
      ctx.logDir !== path.join(ctx.dataDir, "logs")) {
    throw new Error("darwin-daemon-path-contract-mismatch");
  }
}
const defaultRun: CommandRunner = (file, args) => new Promise(resolve => {
  execFile(file, args, {
    encoding: "utf8", timeout: 8_000, maxBuffer: 512 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }, (error, stdout, stderr) => resolve({
    code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
    stdout: String(stdout), stderr: String(stderr),
  }));
});
const absent = (r: CommandResult) => r.code !== 0 &&
  /Could not find service|Could not find specified service/.test(r.stderr + r.stdout);
const baseSnapshot = (): ServiceSnapshot => ({
  state: "unknown", manager: "launchd", since: null, pid: null,
  lastExitCode: null, observedStorePath: null,
  restartCount: null, restartWindowMs: null,
});
async function accessible(file: string, mode = constants.F_OK) {
  try { await fs.access(file, mode); return true; } catch { return false; }
}

export function createDarwinAdapter(options: DarwinOptions = {}): PlatformAdapter {
  const home = absolute(options.homeDir ?? os.homedir(), "homeDir");
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid! < 0) throw new Error("darwin-invalid-user-id");
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const domain = `gui/${uid}`;
  const plistPath = (ctx: ServiceContext) => path.join(home, "Library", "LaunchAgents", `${ctx.serviceName}.plist`);
  const target = (ctx: ServiceContext) => `${domain}/${ctx.serviceName}`;
  const servicePath = (output: string) => /^\s*path = (.+)$/m.exec(output)?.[1]?.trim();

  function plist(ctx: ServiceContext) {
    const args = [ctx.nodePath, path.join(ctx.repoRoot, "scripts", "murmur-daemon.mjs")];
    const environment = {
      DATA_DIR: ctx.dataDir,
      MURMUR_STORE_PATH: ctx.storePath,
      PATH: [path.dirname(ctx.nodePath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n${marker}\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(ctx.serviceName)}</string>
<key>ProgramArguments</key><array>${args.map(x => `<string>${xml(x)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(ctx.repoRoot)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(ctx.logDir, `${ctx.serviceName}.out.log`))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(ctx.logDir, `${ctx.serviceName}.err.log`))}</string>
</dict></plist>\n`;
  }
  async function readOwned(ctx: ServiceContext): Promise<string | null> {
    const file = plistPath(ctx);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("darwin-refuse-nonregular-plist");
      const content = await fs.readFile(file, "utf8");
      if (!content.includes(marker)) throw new Error("darwin-refuse-unmanaged-plist");
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function inspect(ctx: ServiceContext) {
    return run(launchctl, ["print", target(ctx)]);
  }
  function requireSameLoadedPath(ctx: ServiceContext, result: CommandResult) {
    if (servicePath(result.stdout) !== plistPath(ctx)) throw new Error("darwin-refuse-other-loaded-service");
  }
  async function observedStore(pid: number, expected: string): Promise<string | null> {
    const result = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"]);
    if (result.code !== 0) return null;
    let canonical: string;
    try { canonical = await fs.realpath(expected); } catch { return null; }
    for (const line of result.stdout.split("\n")) {
      if (!line.startsWith("n/")) continue;
      try { if (await fs.realpath(line.slice(1)) === canonical) return canonical; } catch { /* closed file */ }
    }
    return null;
  }
  async function status(ctx: ServiceContext): Promise<ServiceSnapshot> {
    validate(ctx);
    const value = baseSnapshot();
    const result = await inspect(ctx);
    if (absent(result)) return { ...value, state: "stopped", detail: "launchd service is not loaded" };
    if (result.code !== 0) return { ...value, detail: "launchctl could not inspect this user service" };
    if (servicePath(result.stdout) !== plistPath(ctx)) return { ...value, detail: "loaded service path differs from the selected profile" };
    const state = /^\s*state = (.+)$/m.exec(result.stdout)?.[1]?.trim();
    const pid = Number(/^\s*pid = (\d+)$/m.exec(result.stdout)?.[1]);
    const exitMatch = /^\s*last exit code = (-?\d+)$/m.exec(result.stdout);
    value.lastExitCode = exitMatch ? Number(exitMatch[1]) : null;
    if (state === "running" && Number.isSafeInteger(pid) && pid > 0) {
      value.state = "running"; value.pid = pid;
      const start = await run("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
      if (start.code === 0 && start.stdout.trim()) {
        const parsed = Date.parse(start.stdout.trim() + " UTC");
        if (Number.isFinite(parsed)) value.since = new Date(parsed).toISOString();
      }
      value.observedStorePath = await observedStore(pid, ctx.storePath);
    } else if (value.lastExitCode !== null && value.lastExitCode !== 0) {
      value.state = "failed";
    } else if (["waiting", "not running", "exited"].includes(state ?? "")) {
      value.state = "stopped";
    }
    return value;
  }
  async function install(ctx: ServiceContext): Promise<void> {
    validate(ctx);
    if (!await accessible(ctx.nodePath, constants.X_OK) ||
        !await accessible(path.join(ctx.repoRoot, "scripts", "murmur-daemon.mjs"))) {
      throw new Error("darwin-daemon-executable-missing");
    }
    const content = plist(ctx);
    const previous = await readOwned(ctx);
    if (previous === content) return;
    const loaded = await inspect(ctx);
    if (!absent(loaded)) {
      if (loaded.code === 0) throw new Error("darwin-stop-service-before-install-update");
      throw new Error("darwin-cannot-confirm-service-unloaded");
    }
    const file = plistPath(ctx);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    await fs.mkdir(ctx.logDir, { recursive: true, mode: 0o700 });
    if (previous !== null) await fs.writeFile(`${file}.backup-${randomUUID()}`, previous, { flag: "wx", mode: 0o600 });
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function start(ctx: ServiceContext): Promise<void> {
    validate(ctx);
    if (await readOwned(ctx) !== plist(ctx)) throw new Error("darwin-install-required-for-current-profile");
    const loaded = await inspect(ctx);
    if (absent(loaded)) {
      const result = await run(launchctl, ["bootstrap", domain, plistPath(ctx)]);
      if (result.code !== 0) throw new Error(`darwin-bootstrap-failed:${result.code}`);
    } else {
      if (loaded.code !== 0) throw new Error("darwin-cannot-inspect-service-before-start");
      requireSameLoadedPath(ctx, loaded);
    }
    const result = await run(launchctl, ["kickstart", target(ctx)]);
    if (result.code !== 0) throw new Error(`darwin-kickstart-failed:${result.code}`);
  }
  async function stop(ctx: ServiceContext): Promise<void> {
    validate(ctx);
    const loaded = await inspect(ctx);
    if (absent(loaded)) return;
    if (loaded.code !== 0) throw new Error("darwin-cannot-inspect-service-before-stop");
    requireSameLoadedPath(ctx, loaded);
    if (await readOwned(ctx) !== plist(ctx)) throw new Error("darwin-stop-profile-mismatch");
    const result = await run(launchctl, ["bootout", target(ctx)]);
    if (result.code !== 0 && !absent(result)) throw new Error(`darwin-bootout-failed:${result.code}`);
  }
  async function detectClients(ctx: ServiceContext): Promise<ClientDetection[]> {
    validate(ctx);
    const appDirs = options.applicationDirs ?? ["/Applications", path.join(home, "Applications")];
    async function hasApp(names: string[], bundleId: string) {
      for (const dir of appDirs) for (const name of names) {
        const info = path.join(absolute(dir, "applicationDir"), name, "Contents", "Info.plist");
        if (!await accessible(info)) continue;
        const result = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", info]);
        if (result.code === 0 && result.stdout.trim() === bundleId) return true;
      }
      return false;
    }
    const executableDirs = options.executableDirs?.map(p => absolute(p, "executableDir")) ?? [...new Set([
      ...(env.PATH ?? "").split(":"), path.join(home, ".local", "bin"),
      "/opt/homebrew/bin", "/usr/local/bin",
    ].filter(p => path.isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p)))];
    async function hasExecutable(name: string) {
      for (const dir of executableDirs) {
        const candidate = path.join(dir, name);
        if (await accessible(candidate, constants.X_OK) && await fs.stat(candidate).then(s => s.isFile(), () => false)) return true;
      }
      return false;
    }
    const codexHome = env.CODEX_HOME || path.join(home, ".codex");
    const codexConfig = path.isAbsolute(codexHome) && !/[\x00-\x1f\x7f]/.test(codexHome)
      ? path.join(codexHome, "config.toml") : null;
    // Do not guess a writable MCP target for non-default Claude profiles.
    // Shared setup may resolve it by a client-supported configuration query.
    const claudeConfig = env.CLAUDE_CONFIG_DIR ? null : path.join(home, ".claude.json");
    return [
      { id: "claude-code", installed: await hasExecutable("claude"), configPath: claudeConfig, format: "json",
        ...(claudeConfig === null ? { detail: "Custom CLAUDE_CONFIG_DIR detected; MCP config target requires client verification" } : {}) },
      { id: "claude-desktop", installed: await hasApp(["Claude.app"], "com.anthropic.claudefordesktop"), configPath: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), format: "json" },
      { id: "codex-cli", installed: await hasExecutable("codex"), configPath: codexConfig, format: "toml" },
      { id: "codex-desktop", installed: await hasApp(["Codex.app", "ChatGPT.app"], "com.openai.codex"), configPath: codexConfig, format: "toml" },
    ];
  }
  return { manager: "launchd" as const, status, install, start, stop, detectClients };
}
