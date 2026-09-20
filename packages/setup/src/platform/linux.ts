import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, readlink, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PlatformAdapter, ProfileUsageSnapshot, ServiceContext, ServiceSnapshot } from "../types.js";
import { classifyProfilePath, ProfileUsageUnknown, verifiedProfileRoot } from "./profile-usage.js";

const exec = promisify(execFile);
const marker = "# Managed by Murmur setup: systemd-v1\n";
export interface LinuxOptions { homeDir?: string; env?: NodeJS.ProcessEnv; run?: (args: string[]) => Promise<string>; procDir?: string }
const unit = (c: ServiceContext) => `${c.serviceName}.service`;
const q = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
const check = (c: ServiceContext) => {
  for (const value of [c.dataDir, c.configPath, c.storePath, c.repoRoot, c.nodePath, c.logDir]) {
    if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || path.normalize(value) !== value) throw new Error("service.invalid-path");
  }
  if (c.configPath !== path.join(c.dataDir, "agent-config.json") || c.storePath !== path.join(c.dataDir, "murmur.db")
    || c.logDir !== path.join(c.dataDir, "logs")) throw new Error("service.conflicting-store-path");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(c.serviceName)) throw new Error("service.invalid-name");
};
export function renderLinuxUnit(c: ServiceContext): string {
  check(c);
  // ExecStart expands $ independently from specifiers; Environment values do not.
  const arg = (v: string) => q(v.replaceAll("$", () => "$$"));
  return `${marker}[Unit]\nDescription=Murmur agent daemon\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${c.repoRoot.replaceAll("%", "%%")}\nEnvironment=${q(`DATA_DIR=${c.dataDir}`)}\nExecStart=${arg(c.nodePath)} ${arg(path.join(c.repoRoot, "scripts", "murmur-daemon.mjs"))}\nStandardOutput=append:${path.join(c.logDir, `${c.serviceName}.out.log`).replaceAll("%", "%%")}\nStandardError=append:${path.join(c.logDir, `${c.serviceName}.err.log`).replaceAll("%", "%%")}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
export function createLinuxAdapter(options: LinuxOptions = {}): PlatformAdapter {
  const env = options.env ?? process.env, home = options.homeDir ?? homedir();
  const procRoot = options.procDir ?? "/proc";
  const run = options.run ?? (async (args: string[]) => {
    try { return (await exec("systemctl", ["--user", ...args], { timeout: 5000, maxBuffer: 256 * 1024 })).stdout; }
    catch (e) {
      const result = e as { stdout?: string };
      if (args[0] === "show" && /^LoadState=not-found$/m.test(result.stdout ?? "")) return result.stdout!;
      throw e;
    }
  });
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user");
  if (!path.isAbsolute(dir)) throw new Error("service.invalid-config-directory");
  const target = (c: ServiceContext) => path.join(dir, unit(c));
  const inspect = async (c: ServiceContext) => Object.fromEntries((await run(["show", unit(c), "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ActiveEnterTimestamp,FragmentPath"]))
    .trim().split("\n").filter(line => line.includes("=")).map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  const sameLoadedPath = (c: ServiceContext, values: Record<string, string>) => {
    if (values.LoadState !== "not-found" && values.FragmentPath !== target(c)) throw new Error("service.foreign-loaded-unit");
  };
  async function readOwned(c: ServiceContext): Promise<string | null> {
    let handle;
    try {
      handle = await open(target(c), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid?.()) throw new Error("service.foreign-unit-file");
      const text = await handle.readFile("utf8");
      if (!text.startsWith(marker)) throw new Error("service.unmanaged-unit");
      return text;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    finally { await handle?.close(); }
  }
  async function requireProfile(c: ServiceContext) {
    check(c); sameLoadedPath(c, await inspect(c));
    if (await readOwned(c) !== renderLinuxUnit(c)) throw new Error("service.profile-mismatch");
  }
  const usageUnknown = (reason = "profile-usage.probe-unavailable"): ProfileUsageSnapshot => ({ state: "unknown", reason });
  const processUnknown = (reason = "profile-usage.process-unverifiable"): never => { throw new ProfileUsageUnknown(reason); };
  function startTime(pid: string, value: string): string {
    if (!value.startsWith(`${pid} (`)) return processUnknown();
    const close = value.lastIndexOf(")");
    if (close < pid.length + 2) return processUnknown();
    const fields = value.slice(close + 1).trim().split(/\s+/);
    const started = fields[19];
    if (fields.length < 20 || !/^\d+$/.test(started ?? "")) return processUnknown();
    return started;
  }
  function credentialUids(status: string): [number, number, number, number] {
    const matches = [...status.matchAll(/^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/gm)];
    if (matches.length !== 1) return processUnknown();
    const uids = matches[0].slice(1).map(Number);
    if (uids.length !== 4 || uids.some(uid => !Number.isSafeInteger(uid) || uid < 0)) return processUnknown();
    return uids as [number, number, number, number];
  }
  async function processIdentity(pid: string): Promise<{ uids: [number, number, number, number]; started: string; proof: string }> {
    try {
      const statFile = path.join(procRoot, pid, "stat");
      const before = startTime(pid, await readFile(statFile, "utf8"));
      const statusFile = path.join(procRoot, pid, "status");
      const firstUids = credentialUids(await readFile(statusFile, "utf8"));
      const secondUids = credentialUids(await readFile(statusFile, "utf8"));
      const after = startTime(pid, await readFile(statFile, "utf8"));
      if (before !== after) return processUnknown("profile-usage.process-set-changed");
      if (firstUids.some((uid, index) => uid !== secondUids[index])) {
        return processUnknown("profile-usage.process-identity-changed");
      }
      return { uids: firstUids, started: before, proof: `${before}:${firstUids.join(":")}` };
    } catch (error) {
      if (error instanceof ProfileUsageUnknown) throw error;
      return processUnknown();
    }
  }
  async function ownedProcesses(uid: number): Promise<Map<string, string>> {
    let entries;
    try { entries = await readdir(procRoot, { withFileTypes: true }); }
    catch { return processUnknown(); }
    const result = new Map<string, string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!/^\d+$/.test(entry.name)) continue;
      if (!entry.isDirectory()) return processUnknown();
      if (entry.name === String(process.pid)) continue;
      const identity = await processIdentity(entry.name);
      if (identity.uids.includes(uid)) result.set(entry.name, identity.proof);
    }
    return result;
  }
  const sameProcesses = (a: Map<string, string>, b: Map<string, string>) =>
    a.size === b.size && [...a].every(([pid, proof]) => b.get(pid) === proof);
  async function profileUsage(c: ServiceContext): Promise<ProfileUsageSnapshot> {
    check(c);
    try {
      const uid = process.getuid?.();
      if (!Number.isSafeInteger(uid) || uid! < 0) return usageUnknown();
      const profile = await verifiedProfileRoot(c);
      const before = await ownedProcesses(uid!);
      let held = false;
      for (const [pid, identity] of before) {
        if ((await processIdentity(pid)).proof !== identity) return usageUnknown("profile-usage.process-identity-changed");
        let descriptors: string[];
        try { descriptors = (await readdir(path.join(procRoot, pid, "fd"))).sort(); }
        catch { return usageUnknown("profile-usage.process-unverifiable"); }
        for (const descriptor of descriptors) {
          if (!/^\d+$/.test(descriptor)) return usageUnknown("profile-usage.process-unverifiable");
          let target: string;
          try { target = await readlink(path.join(procRoot, pid, "fd", descriptor)); }
          catch { return usageUnknown("profile-usage.process-unverifiable"); }
          if (/^(?:socket|pipe):\[\d+\]$/.test(target) || /^anon_inode:\[[^\]\r\n]+\]$/.test(target)) continue;
          if (/^\/memfd:[^\r\n]+(?: \(deleted\))?$/.test(target)) continue;
          const classification = await classifyProfilePath(profile.root, target);
          if (classification === "unknown") return usageUnknown("profile-usage.process-unverifiable");
          if (classification === "inside") held = true;
        }
        if ((await processIdentity(pid)).proof !== identity) return usageUnknown("profile-usage.process-identity-changed");
      }
      if (held) return { state: "in-use", reason: "profile-usage.open-file" };
      const after = await ownedProcesses(uid!);
      if (!sameProcesses(before, after)) return usageUnknown("profile-usage.process-set-changed");
      const profileAfter = await verifiedProfileRoot(c);
      if (profileAfter.root !== profile.root || profileAfter.proof !== profile.proof) {
        return usageUnknown("profile-usage.profile-changed");
      }
      return { state: "free", reason: "profile-usage.no-open-files" };
    } catch (error) {
      return usageUnknown(error instanceof ProfileUsageUnknown ? error.reason : undefined);
    }
  }
  return {
    manager: "systemd",
    async status(c) {
      check(c);
      const result: ServiceSnapshot = { state: "unknown", manager: "systemd", since: null, pid: null,
        lastExitCode: null, observedStorePath: null, restartCount: null, restartWindowMs: null };
      let values: Record<string, string>;
      try { values = await inspect(c); sameLoadedPath(c, values); }
      catch { return { ...result, detail: "service.manager-or-profile-unavailable" }; }
      if (values.LoadState === "not-found") return { ...result, state: "stopped", detail: "service.not-installed" };
      result.state = values.ActiveState === "failed" ? "failed" : values.ActiveState === "active" && values.SubState === "running" ? "running"
        : values.ActiveState === "inactive" ? "stopped" : "unknown";
      result.pid = Number(values.MainPID) > 0 ? Number(values.MainPID) : null;
      result.lastExitCode = /^\d+$/.test(values.ExecMainStatus ?? "") ? Number(values.ExecMainStatus) : null;
      const started = Date.parse(values.ActiveEnterTimestamp ?? "");
      result.since = Number.isFinite(started) ? new Date(started).toISOString() : null;
      if (result.pid) {
        try {
          const expected = await realpath(c.storePath), fdDir = path.join(procRoot, String(result.pid), "fd");
          for (const fd of await readdir(fdDir)) {
            try { if (await readlink(path.join(fdDir, fd)) === expected) { result.observedStorePath = expected; break; } } catch {}
          }
        } catch { /* Inaccessible descriptors mean unverified, not guessed from config. */ }
      }
      return result;
    },
    async install(c) {
      check(c);
      const values = await inspect(c); sameLoadedPath(c, values);
      const previous = await readOwned(c), content = renderLinuxUnit(c);
      if (previous !== content && !["inactive", "failed", undefined].includes(values.ActiveState)) throw new Error("service.stop-before-update");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await mkdir(c.logDir, { recursive: true, mode: 0o700 });
      if (previous !== content) {
        if (previous !== null) await writeFile(`${target(c)}.backup-${randomUUID()}`, previous, { flag: "wx", mode: 0o600 });
        const temporary = `${target(c)}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, target(c)); }
        finally { await unlink(temporary).catch(() => {}); }
      }
      await run(["daemon-reload"]); await run(["enable", unit(c)]);
    },
    async start(c) { await requireProfile(c); await run(["start", unit(c)]); },
    async stop(c) {
      check(c); const values = await inspect(c);
      if (values.LoadState === "not-found") return;
      await requireProfile(c); await run(["stop", unit(c)]);
    },
    async detectClients() {
      const rows = [];
      for (const [id, command, configPath, format] of [
        ["claude-code", "claude", env.CLAUDE_CONFIG_DIR ? null : path.join(home, ".claude.json"), "json"],
        ["codex-cli", "codex", path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml"), "toml"],
      ] as const) {
        let installed = false;
        for (const candidate of (env.PATH ?? "").split(path.delimiter)) {
          if (!path.isAbsolute(candidate)) continue;
          try { const file = path.join(candidate, command); await access(file, constants.X_OK); if ((await stat(file)).isFile()) { installed = true; break; } } catch {}
        }
        rows.push({ id, installed, configPath, format, ...(configPath === null ? { detail: "Custom Claude profile requires client verification" } : {}) });
      }
      return rows;
    },
    profileUsage,
  };
}
