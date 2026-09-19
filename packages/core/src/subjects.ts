import { createHash } from "node:crypto";

export interface ChannelSubjectRoute {
  subject: string;
  durableName: string;
  channelId?: string;
}

/** Encode a channel as one literal NATS token, including dots, Unicode and wildcards. */
export function channelScopedSubject(baseSubject: string, channelId: string): string {
  if (!/^msg\.[^\s.*>]+$/.test(baseSubject)) throw new Error("subject-scoping-invalid-base");
  if (typeof channelId !== "string" || !channelId.trim() || Buffer.byteLength(channelId, "utf8") > 512) throw new Error("subject-scoping-invalid-channel");
  return `${baseSubject}.c_${Buffer.from(channelId, "utf8").toString("base64url")}`;
}

/** A receiver is upgraded before individual peer publishers opt into scoped sends. */
export function resolveMessageSubject(peer: { subject: string; subjectScoping?: boolean }, channelId?: string): string {
  if (peer.subjectScoping !== undefined && typeof peer.subjectScoping !== "boolean") throw new Error("subject-scoping-invalid-flag");
  return peer.subjectScoping && channelId ? channelScopedSubject(peer.subject, channelId) : peer.subject;
}

export function channelSubjectRoutes(baseSubject: string, consumerId: string, config?: { enabled?: boolean; channelIds?: string[] }): ChannelSubjectRoute[] {
  const legacy = { subject: baseSubject, durableName: consumerId };
  if (config?.enabled !== true) return [legacy];
  if (!Array.isArray(config.channelIds) || config.channelIds.length === 0 || config.channelIds.length > 256) throw new Error("subject-scoping-channel-list-required");
  if (new Set(config.channelIds).size !== config.channelIds.length) throw new Error("subject-scoping-duplicate-channel");
  return [legacy, ...config.channelIds.map((channelId) => ({
    channelId,
    subject: channelScopedSubject(baseSubject, channelId),
    durableName: `murmur-ch-${createHash("sha256").update(JSON.stringify([baseSubject, consumerId, channelId])).digest("hex").slice(0, 32)}`,
  }))];
}

/** Match a literal subject against a stream's NATS wildcard pattern. */
export function subjectMatchesFilter(subject: string, filter: string): boolean {
  const tokens = subject.split(".");
  const pattern = filter.split(".");
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === ">") return i === pattern.length - 1 && tokens.length > i;
    if (tokens[i] === undefined || (pattern[i] !== "*" && pattern[i] !== tokens[i])) return false;
  }
  return tokens.length === pattern.length;
}
