import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PlatformAdapter, ServiceContext, ServiceSnapshot } from "../types.js";

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
  async function observeStore(c: ServiceContext, pid: number): Promise<string | null> {
    check(c);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      const expected = await realpath(c.storePath), fdDir = path.join(options.procDir ?? "/proc", String(pid), "fd");
      for (const fd of await readdir(fdDir)) {
        try { if (await realpath(path.join(fdDir, fd)) === expected) return expected; } catch {}
      }
    } catch { /* Inaccessible or exited processes are not liveness evidence. */ }
    return null;
  }
  return {
    manager: "systemd",
    observeStore,
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
      if (result.pid) result.observedStorePath = await observeStore(c, result.pid);
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
  };
}
