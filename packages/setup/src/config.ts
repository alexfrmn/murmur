import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { buildSecureNatsConnectionOptions, type NatsTlsOptions } from "@murmurv2/core";
import type { ServiceContext } from "./types.js";

export interface PeerConfig { subject: string; encryption: { publicKey: string }; signing: { publicKey: string };
  channelId?: string; memberId?: string; subjectScoping?: boolean }
export interface AgentConfig {
  agentId: string; subject: string; natsUrl: string; natsToken?: string; natsUser?: string; natsPassword?: string; natsTls?: NatsTlsOptions;
  keys: { encryption: { publicKey: string; privateKey: string }; signing: { publicKey: string; privateKey: string } };
  peers: Record<string, PeerConfig>; memberId?: string;
  subjectScoping?: { enabled?: boolean; channelIds?: string[] };
  onReceive?: string; wake?: { enabled?: boolean; mode?: string; peers?: Record<string, { mode?: string }> };
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const validAgentId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const validKey = (v: unknown) => typeof v === "string" && Buffer.from(v, "base64").length === 32 && Buffer.from(v, "base64").toString("base64") === v;
export function validateConfig(input: unknown, options: { allowLegacyRemotePlaintext?: boolean } = {}): AgentConfig {
  if (!object(input) || !validAgentId(input.agentId) || input.subject !== `msg.${input.agentId}`) throw new Error("config.identity-invalid");
  if (typeof input.natsUrl !== "string") throw new Error("config.broker-url-invalid");
  const tls = input.natsTls;
  if (tls !== undefined && !object(tls)) throw new Error("config.broker-tls-invalid");
  for (const value of [input.natsToken, input.natsUser, input.natsPassword]) if (value !== undefined && (typeof value !== "string" || !value || /[\r\n\0]/.test(value))) throw new Error("config.broker-auth-invalid");
  if (object(tls)) for (const key of ["caFile", "certFile", "keyFile"] as const) {
    const value = tls[key]; if (value !== undefined && (typeof value !== "string" || !path.isAbsolute(value))) throw new Error("config.broker-tls-file-invalid");
  }
  try { buildSecureNatsConnectionOptions({ url: input.natsUrl, token: input.natsToken, user: input.natsUser, password: input.natsPassword, tls: tls as NatsTlsOptions | undefined }); }
  catch (error) {
    if (!(options.allowLegacyRemotePlaintext && error instanceof Error && error.message === "nats-plaintext-non-loopback-rejected")) throw error;
  }
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
  return (await readJsonSnapshot(file)).value;
}
export async function readJsonSnapshot(file: string): Promise<{ value: any; bytes: Buffer }> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("config.file-invalid");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("config.owner-mismatch");
    const bytes=Buffer.alloc(4*1024*1024+1);let offset=0;
    while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,null);if(result.bytesRead===0)break;offset+=result.bytesRead;}
    const after=await handle.stat();
    if(offset>4*1024*1024 || after.dev!==stat.dev || after.ino!==stat.ino || after.size!==stat.size || offset!==stat.size) throw new Error("config.file-changed");
    const exact=bytes.subarray(0,offset);
    return {value:JSON.parse(exact.toString("utf8")),bytes:Buffer.from(exact)};
  } finally { await handle.close(); }
}
export async function loadConfig(context: ServiceContext): Promise<AgentConfig> {
  try { return validateConfig(await readJson(context.configPath)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("config.missing"); throw e; }
}

export function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? "");
  if (value === "database is locked") return value;
  // Only stable program codes are printable. Arbitrary transport, URL, username,
  // password, token and private-key text is never reflected to status/doctor.
  const natsPolicy=new Set(["nats-url-invalid","nats-url-scheme-invalid","nats-url-embedded-credentials-rejected","nats-url-components-invalid",
    "nats-auth-methods-conflict","nats-user-password-pair-required","nats-plaintext-non-loopback-rejected","nats-tls-options-require-tls-url",
    "nats-tls-server-name-required-for-ip","nats-tls-server-name-invalid","nats-tls-option-unsupported","nats-tls-file-invalid",
    "nats-tls-cert-key-pair-required","nats-tls-handshake-first-invalid"]);
  return natsPolicy.has(value) || /^(?:config|broker-input|onboarding|migration|broker|daemon|peers|roundtrip|wake|service|clients|logs|updates|inbox|status|state|cli)\.[a-z0-9_.-]+(?::[a-z0-9_.-]+)?$/i.test(value)
    ? value : "operation-failed";
}
