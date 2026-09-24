import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ServiceContext } from "./types.js";

export interface PeerConfig { subject: string; encryption: { publicKey: string }; signing: { publicKey: string };
  channelId?: string; memberId?: string; subjectScoping?: boolean }
export interface AgentConfig {
  agentId: string; subject: string; natsUrl: string; natsToken?: string;
  keys: { encryption: { publicKey: string; privateKey: string }; signing: { publicKey: string; privateKey: string } };
  peers: Record<string, PeerConfig>; memberId?: string;
  subjectScoping?: { enabled?: boolean; channelIds?: string[] };
  onReceive?: string; wake?: { enabled?: boolean; mode?: string; peers?: Record<string, { mode?: string }> };
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const validAgentId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const validKey = (v: unknown) => typeof v === "string" && Buffer.from(v, "base64").length === 32 && Buffer.from(v, "base64").toString("base64") === v;
export function validateConfig(input: unknown): AgentConfig {
  if (!object(input) || !validAgentId(input.agentId) || input.subject !== `msg.${input.agentId}`) throw new Error("config.identity-invalid");
  let url: URL;
  try { url = new URL(input.natsUrl); } catch { throw new Error("config.broker-url-invalid"); }
  if (!["nats:", "tls:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("config.broker-url-invalid");
  for (const kind of ["encryption", "signing"]) {
    if (!validKey(input.keys?.[kind]?.publicKey) || !validKey(input.keys?.[kind]?.privateKey)) throw new Error("config.keys-invalid");
  }
  if (!object(input.peers)) throw new Error("config.peers-invalid");
  for (const [id, peer] of Object.entries(input.peers)) {
    if (!validAgentId(id) || !object(peer) || typeof peer.subject !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(peer.subject)
      || !validKey(peer.encryption?.publicKey) || !validKey(peer.signing?.publicKey)) throw new Error("config.peer-invalid");
  }
  return input as AgentConfig;
}

/** Read-only: status and doctor never chmod, initialize, or migrate user state. */
export async function readJson(file: string): Promise<any> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("config.file-invalid");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("config.owner-mismatch");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
export async function loadConfig(context: ServiceContext): Promise<AgentConfig> {
  try { return validateConfig(await readJson(context.configPath)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("config.missing"); throw e; }
}

export function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? "");
  if (value === "database is locked") return value;
  // Neither command output nor transport errors may leak tokens/message content.
  if (/^[a-zA-Z][a-zA-Z0-9_.:-]{0,150}$/.test(value)) return value;
  // System error messages embed paths; their errno code and syscall alone are safe and actionable
  // (an unreadable invite file must not surface as a bare operation-failed).
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
  if (typeof code === "string" && /^E[A-Z0-9]{1,30}$/.test(code)) {
    return typeof syscall === "string" && /^[a-z_]{1,30}$/.test(syscall) ? `system.${code}:${syscall}` : `system.${code}`;
  }
  return "operation-failed";
}

/** CLI presentation only; JSON consumers retain the stable, secret-free codes. */
export function humanError(error: unknown): string {
  const code = safeError(error);
  if (code === 'onboarding.invite-public-server-required') {
    return 'This Invitation needs a public Server address. Ask for its public address and pass it with --broker.';
  }
  if (code === 'onboarding.invite-server-address-invalid') {
    return 'Enter a valid public Server address with --broker, such as nats://server.example.com:4222. Do not include an access key in the address.';
  }
  return code;
}
