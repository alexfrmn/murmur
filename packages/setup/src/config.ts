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
  const messages: Record<string, string> = {
    'accepted-turn-unobservable': 'The Assistant accepted this message, but its outcome cannot be checked. Inspect its session before dismissing the alert; do not send the instruction again.',
    'wake.selection-invalid': 'Choose a message and the expected Identity, then try again.',
    'wake.identity-changed': 'The selected Identity has changed. Check its name before dismissing this alert.',
    'wake.dismiss-not-eligible': 'This alert cannot be dismissed here. Check the message status and the selected Identity.',
    'wake.store-invalid': 'Choose the original message history owned by your account, then try again.',
    'onboarding.input-required': 'Provide the Invitation or Reply using standard input or choose its saved file.',
    'onboarding.input-conflict': 'Choose one source for the Invitation or Reply: standard input or a saved file.',
    'onboarding.stdin-required': 'Send the Invitation or Reply through standard input, or choose its saved file.',
    'onboarding.input-too-large': 'This Invitation or Reply is too long. Ask your colleague to send a new one.',
    'onboarding.file-invalid': 'This file cannot be used. Choose the saved Invitation or Reply your colleague sent.',
    'onboarding.invalid-blob': 'This Invitation or Reply is incomplete or damaged. Copy the whole line your colleague sent.',
    'onboarding.invalid-peer': 'This is not the expected Invitation or Reply. Ask your colleague to send the correct one.',
    'onboarding.invalid-peer-key': 'The Contact details are damaged. Ask your colleague for a new Invitation or Reply.',
    'onboarding.invalid-broker': 'The Invitation has invalid Server details. Ask your colleague for a new Invitation.',
    'onboarding.self-peer': 'This is your own Identity. Ask your colleague to send their Reply.',
    'onboarding.peer-key-conflict': 'This Contact has different Identity details. Verify the change with your colleague before replacing the Contact.',
    'onboarding.existing-profile-conflict': 'Another Identity already uses this folder. Choose that Identity or an empty folder.',
    'onboarding.file-must-be-absolute': 'Choose the input file using its full path.',
    'onboarding.output-must-be-absolute': 'Choose the destination file using its full path.',
    'onboarding.output-parent-required': 'Choose an existing folder to save the Invitation or Reply.',
    'onboarding.output-inside-profile': 'Choose a destination outside the folder containing your Identity settings.',
    'onboarding.token-file-invalid': 'The Server access key must be one line. Ask for the correct key and save it again.',
    'onboarding.private-acl-failed': 'The file could not be protected. Choose a private folder you can write to and try again.',
    'onboarding.user-sid-unavailable': 'Your account could not be verified. Sign in again and retry.',
    'onboarding.poison-reset-failed': 'The Contact was saved, but waiting messages could not be prepared. Check the connection and retry.',
    'config.missing': 'Set up your Identity or choose its existing folder, then try again.',
    'config.identity-invalid': 'Choose an Identity name using letters, numbers, hyphens or underscores.',
    'config.broker-url-invalid': 'Enter a valid Server address supplied by your colleague and try again.',
    'service.running-unmanaged': 'This Service is running outside this app. Manage it where it was started.',
    'cli.unknown-command': 'This command is not available. Run with --help to choose an action.',
    'cli.unknown-option': 'This option is not available. Run with --help to check the command.',
    'cli.invalid-arguments': 'The command is incomplete. Run with --help to check the required options.',
  };
  if (Object.hasOwn(messages, code)) return messages[code];
  if (/^onboarding\.(invite|reply|token)-file-not-found$/.test(code)) return 'The selected file was not found. Choose the saved Invitation, Reply or Server access key again.';
  if (/^onboarding\.(invite|reply|token)-file-access-denied$/.test(code)) return 'The selected file cannot be opened. Choose a file your account can read.';
  if (code.startsWith('cli.required-option:')) return 'A required option is missing. Run with --help to complete the command.';
  if (code.startsWith('system.EEXIST')) return 'The destination already exists or another setup is in progress. Choose a new destination or wait for setup to finish.';
  if (/^system\.(EACCES|EPERM)/.test(code)) return 'Access was denied. Choose a folder your account can read and write.';
  if (code === 'database is locked') return 'Your messages are busy with another action. Wait a moment and try again.';
  return 'This action could not be completed. Check your settings and use --json to share diagnostics with your support contact.';
}
