import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServiceContext, ServiceSnapshot, ClientDetection, PlatformAdapter, ProfileUsageSnapshot } from "../types.js";
import { classifyProfilePath, ProfileUsageUnknown, verifiedProfileRoot } from "./profile-usage.js";

export interface CommandResult { code: number; stdout: string; stderr: string; pid?: number }
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;
export interface DarwinOptions {
  homeDir?: string; uid?: number; env?: NodeJS.ProcessEnv; run?: CommandRunner;
  /** Uses a larger, still bounded output buffer for the profile-wide lsof probe. */
  profileRun?: CommandRunner;
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
const commandRunner = (maxBuffer: number): CommandRunner => (file, args) => new Promise(resolve => {
  const child = execFile(file, args, {
    encoding: "utf8", timeout: 8_000, maxBuffer,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }, (error, stdout, stderr) => resolve({
    code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
    stdout: String(stdout), stderr: String(stderr), pid: child.pid,
  }));
});
const defaultRun = commandRunner(512 * 1024);
const defaultProfileRun = commandRunner(8 * 1024 * 1024);
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
  const profileRun = options.profileRun ?? options.run ?? defaultProfileRun;
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
  const usageUnknown = (reason = "profile-usage.probe-unavailable"): ProfileUsageSnapshot => ({ state: "unknown", reason });
  interface LsofRecord { pid: number; descriptor: string; type: string; name: string }
  interface LsofSnapshot { pids: Set<number>; records: LsofRecord[] }
  function lsofSnapshot(output: string): LsofSnapshot {
    if (output.includes("\0") || !output.endsWith("\n")) throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
    const lines = output.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.some(line => line === "")) throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
    const records: LsofRecord[] = [];
    let pid: number | null = null, descriptor: string | null = null, type: string | null = null;
    let processHasRecord = false;
    const seen = new Set<number>();
    for (const line of lines) {
      if (line.startsWith("p")) {
        if (descriptor !== null || type !== null || pid !== null && !processHasRecord || !/^p[1-9]\d*$/.test(line)) {
          throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
        }
        pid = Number(line.slice(1));
        if (!Number.isSafeInteger(pid) || seen.has(pid)) throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
        seen.add(pid);
        processHasRecord = false;
      } else if (line.startsWith("f")) {
        if (pid === null || descriptor !== null || type !== null || line.length < 2 || /[\0\r\n]/.test(line)) {
          throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
        }
        descriptor = line.slice(1);
      } else if (line.startsWith("t")) {
        if (pid === null || descriptor === null || type !== null || line.length < 2 || /[\0\r\n]/.test(line)) {
          throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
        }
        type = line.slice(1);
      } else if (line.startsWith("n")) {
        if (pid === null || descriptor === null || type === null) {
          throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
        }
        // Apple's process_netpolicy() sets NPOLICY but no name. Native lsof also
        // emits unnamed NEXUS FDs; XNU gives that Skywalk controller its own
        // fileops, separate from vnodes. Only these exact numeric FD types may
        // have an empty n; missing n, other empty types and pseudo-FDs refuse.
        // https://github.com/apple-opensource/lsof/blob/da09c8c6436286e5bd8c400b42e86b54404f12a7/lsof/dialects/darwin/libproc/dnetpolicy.c
        // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/skywalk/nexus/nexus_syscalls.c
        if (line.length === 1 && !((type === "NPOLICY" || type === "NEXUS") && /^\d+$/.test(descriptor))) {
          throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
        }
        records.push({ pid, descriptor, type, name: line.slice(1) });
        descriptor = type = null;
        processHasRecord = true;
      } else {
        throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
      }
    }
    if (descriptor !== null || type !== null || pid !== null && !processHasRecord) {
      throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
    }
    return { pids: seen, records };
  }
  interface ProcessObservation { uid: number; start: string; zombie: boolean }
  function processSnapshot(result: CommandResult): Map<number, ProcessObservation> {
    if (result.code !== 0 || result.stderr.trim() !== "" || !Number.isSafeInteger(result.pid) || result.pid! <= 0) {
      throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
    }
    const observations = new Map<number, ProcessObservation>();
    const lines = result.stdout.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      const match = /^\s*([1-9]\d*)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
      const pid = Number(match[1]), uid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(uid) || observations.has(pid)) {
        throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
      }
      observations.set(pid, { uid, start: match[4]!, zombie: match[3]!.startsWith("Z") });
    }
    // /bin/ps is setuid-root on macOS, so its exact child PID may have UID 0.
    // Verify and remove only that exact observer from the full process set.
    if (!observations.has(result.pid!) || !observations.has(process.pid)) {
      throw new ProfileUsageUnknown("profile-usage.process-unverifiable");
    }
    observations.delete(result.pid!);
    for (const anchor of new Set([1, process.ppid])) {
      if (!observations.has(anchor)) throw new ProfileUsageUnknown("profile-usage.process-visibility-incomplete");
    }
    return observations;
  }
  async function profileUsage(ctx: ServiceContext): Promise<ProfileUsageSnapshot> {
    validate(ctx);
    try {
      const profile = await verifiedProfileRoot(ctx);
      let control: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        control = await fs.open(ctx.configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const [opened, selected, canonical] = await Promise.all([
          control.stat(), fs.lstat(ctx.configPath), fs.realpath(ctx.configPath),
        ]);
        const currentUid = process.getuid?.();
        if (currentUid === undefined || !opened.isFile() || !selected.isFile() || selected.isSymbolicLink()
          || opened.uid !== currentUid || selected.uid !== currentUid
          || (opened.mode & 0o077) !== 0 || (selected.mode & 0o077) !== 0
          || opened.dev !== selected.dev || opened.ino !== selected.ino || canonical !== ctx.configPath) return usageUnknown();

        // Apple's lsof 4.91 makes every +D entry a required search argument,
        // so an unopened entry forces exit 1. Scan all processes and prove
        // lsof coverage with stable ps snapshots around the observation.
        const psArgs = ["-axo", "pid=,uid=,stat=,lstart="];
        const before = processSnapshot(await profileRun("/bin/ps", psArgs));
        const result = await profileRun("/usr/sbin/lsof", ["-n", "-P", "-Fpftn"]);
        if (result.code !== 0 || result.stderr.trim() !== "") return usageUnknown();
        const snapshot = lsofSnapshot(result.stdout);
        const after = processSnapshot(await profileRun("/bin/ps", psArgs));
        const stable = new Set<number>();
        if (before.size !== after.size) return usageUnknown("profile-usage.process-unverifiable");
        for (const [pid, first] of before) {
          const second = after.get(pid);
          if (!second || first.uid !== second.uid || first.start !== second.start || first.zombie !== second.zombie) {
            return usageUnknown("profile-usage.process-unverifiable");
          }
          if (!first.zombie) stable.add(pid);
        }
        if ([...stable].some(pid => !snapshot.pids.has(pid))) {
          return usageUnknown("profile-usage.process-unverifiable");
        }
        let controlSeen = false, held = false;
        const filesystemTypes = new Set(["REG", "DIR", "LINK"]);
        const otherTypes = new Set(["ATALK", "BLK", "CHR", "FIFO", "FSEVENTS", "IPv4", "IPv6", "KQUEUE",
          "NPOLICY", "NEXUS", "PIPE", "PSXSEM", "PSXSHM", "key", "ndrv", "ppp", "rte", "sock", "systm", "unix",
          "vsock", "vsockp"]);
        const classifications = new Map<string, Promise<"inside" | "outside" | "unknown">>();
        for (const record of snapshot.records) {
          if (!filesystemTypes.has(record.type)) {
            if (!otherTypes.has(record.type)) return usageUnknown("profile-usage.process-unverifiable");
            continue;
          }
          let classificationPromise = classifications.get(record.name);
          if (!classificationPromise) {
            classificationPromise = classifyProfilePath(profile.root, record.name);
            classifications.set(record.name, classificationPromise);
          }
          const classification = await classificationPromise;
          if (classification === "unknown") return usageUnknown("profile-usage.process-unverifiable");
          if (classification === "outside") continue;
          if (record.pid === process.pid) {
            const [recordPath, recordInfo] = await Promise.all([fs.realpath(record.name), fs.stat(record.name)]);
            if (recordPath === canonical && recordInfo.dev === opened.dev && recordInfo.ino === opened.ino) controlSeen = true;
          } else {
            held = true;
          }
        }
        if (!controlSeen) return usageUnknown("profile-usage.control-unobserved");
        if (held) return { state: "in-use", reason: "profile-usage.open-file" };
        const profileAfter = await verifiedProfileRoot(ctx);
        if (profileAfter.root !== profile.root || profileAfter.proof !== profile.proof) {
          return usageUnknown("profile-usage.profile-changed");
        }
        return { state: "free", reason: "profile-usage.no-open-files" };
      } finally {
        await control?.close();
      }
    } catch (error) {
      return usageUnknown(error instanceof ProfileUsageUnknown ? error.reason : undefined);
    }
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
  return { manager: "launchd" as const, status, install, start, stop, detectClients, profileUsage };
}
