import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, type BigIntStats } from "node:fs";
import path from "node:path";

export interface AgentConfig {
  agentId: string;
  memberId?: string;
  natsUrl: string;
  natsToken?: string;
  subject: string;
  subjectScoping?: { enabled?: boolean; channelIds?: string[] };
  dataDir: string;
  keys: {
    encryption: { publicKey: string; privateKey: string };
    signing: { publicKey: string; privateKey: string };
  };
  peers: Record<
    string,
    {
      encryption: { publicKey: string };
      signing: { publicKey: string };
      subject: string;
      subjectScoping?: boolean;
      channelId?: string;
      memberId?: string;
    }
  >;
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && (process.platform === "win32"
  ? a.dev === 0n || b.dev === 0n || BigInt.asUintN(32, a.dev) === BigInt.asUintN(32, b.dev)
  : a.dev === b.dev);
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.mtimeNs, s.ctimeNs, s.size, s.mode, s.uid].join(":");
const validateFile = (s: BigIntStats) => {
  if (s.isSymbolicLink() || !s.isFile()) throw new Error("agent-config-file-invalid");
  if (typeof process.getuid === "function" && s.uid !== BigInt(process.getuid())) throw new Error("agent-config-file-owner-mismatch");
};
const identity = (c: AgentConfig) => JSON.stringify([c.agentId,
  c.keys?.encryption?.publicKey, c.keys?.encryption?.privateKey,
  c.keys?.signing?.publicKey, c.keys?.signing?.privateKey]);
const binding = (c: AgentConfig) => JSON.stringify([c.memberId, c.subject, c.natsUrl, c.natsToken, c.dataDir,
  c.subjectScoping?.enabled, [...(c.subjectScoping?.channelIds ?? [])].sort()]);

/** Peer-only refresh; a process remains bound to its first valid identity/runtime. */
export class AgentConfigCache {
  private cached: { config: AgentConfig; stamp: string } | null = null;
  private pinnedIdentity: string | undefined;
  private pinnedBinding: string | undefined;
  private directory: BigIntStats | undefined;

  constructor(private readonly filePath: string) {}

  read(force = false): AgentConfig {
    try {
      process.umask(0o077);
      const dir = path.dirname(this.filePath);
      const directory = lstatSync(dir, { bigint: true });
      if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("agent-config-directory-invalid");
      if (typeof process.getuid === "function" && directory.uid !== BigInt(process.getuid())) throw new Error("agent-config-directory-owner-mismatch");
      if (this.directory && !sameFile(this.directory, directory)) throw new Error("agent-config-profile-changed-restart-required");
      chmodSync(dir, 0o700);
      const before = lstatSync(this.filePath, { bigint: true });
      validateFile(before);
      if (!force && this.cached?.stamp === stamp(before)) return this.cached.config;

      const fd = openSync(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let config: AgentConfig, finalStats: BigIntStats;
      try {
        const opened = fstatSync(fd, { bigint: true });
        validateFile(opened);
        if (!sameFile(before, opened) || before.size !== opened.size || before.mtimeNs !== opened.mtimeNs) throw new Error("agent-config-file-changed");
        fchmodSync(fd, 0o600);
        const reading = fstatSync(fd, { bigint: true });
        const contents = readFileSync(fd, "utf8");
        finalStats = fstatSync(fd, { bigint: true });
        const after = lstatSync(this.filePath, { bigint: true });
        validateFile(after);
        if (!sameFile(opened, after) || stamp(reading) !== stamp(finalStats)
            || after.size !== finalStats.size || after.mtimeNs !== finalStats.mtimeNs || after.ctimeNs !== finalStats.ctimeNs
            || !sameFile(directory, lstatSync(dir, { bigint: true }))) throw new Error("agent-config-file-changed");
        // Path and handle dev differ on Node 22.13/Windows; cache the path stamp.
        finalStats = after;
        config = JSON.parse(contents) as AgentConfig;
      } finally { closeSync(fd); }
      if (!config || typeof config.agentId !== "string" || !config.agentId.trim()
          || !config.peers || typeof config.peers !== "object" || Array.isArray(config.peers)) throw new Error("agent-config-invalid");
      const nextIdentity = identity(config), nextBinding = binding(config);
      if (this.pinnedIdentity !== undefined && nextIdentity !== this.pinnedIdentity) throw new Error("agent-config-identity-changed-restart-required");
      if (this.pinnedBinding !== undefined && nextBinding !== this.pinnedBinding) throw new Error("agent-config-runtime-changed-restart-required");
      this.pinnedIdentity = nextIdentity;
      this.pinnedBinding = nextBinding;
      this.directory = directory;
      this.cached = { config, stamp: stamp(finalStats) };
      return config;
    } catch (error) {
      this.cached = null; // Never send with old peer keys after any read/parse/policy failure.
      if (error instanceof Error && /^agent-config-[a-z-]+$/.test(error.message)) throw error;
      throw new Error("agent-config-unavailable-retry-or-restart");
    }
  }
}
