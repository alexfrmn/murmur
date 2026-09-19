// Murmur Phase N / N1 — typed channel roster.
// This is intentionally separate from local_messages: conversationId remains a history label,
// while channelId is the stable routing/personality primitive for N2/N3.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChannelType = "dm" | "group" | "consult";

/** Advisory chat presence, independent from transport liveness and lease ownership. */
export interface ChannelSessionPresence {
  channelId: string;
  conversationId: string;
  memberId: string;
  agentId: string;
  sessionId: string;
  status: "active" | "idle" | "busy";
  joinedAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface ChannelSessionIdentity {
  channelId: string;
  memberId: string;
  agentId: string;
  sessionId: string;
}

export interface ChannelSessionHeartbeat extends ChannelSessionIdentity {
  status?: ChannelSessionPresence["status"];
  ttlMs?: number;
  now?: number;
}

export interface ChannelRecord {
  channelId: string;
  conversationId: string;
  type: ChannelType;
  createdAt: string;
  closedAt?: string;
  metadata: Record<string, unknown>;
}

export interface ChannelMemberRecord {
  channelId: string;
  memberId: string;
  memberSlot?: string;
  agentId: string;
  role?: string;
  personaId?: string;
  model?: string;
  baseInstructionsHash?: string;
  joinedAt: string;
  leftAt?: string;
  eligibility: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ChannelMemberInput {
  memberId: string;
  memberSlot?: string;
  agentId: string;
  role?: string;
  personaId?: string;
  model?: string;
  baseInstructionsHash?: string;
  joinedAt?: string;
  leftAt?: string;
  eligibility?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CreateChannelInput {
  channelId: string;
  conversationId: string;
  type: ChannelType;
  createdAt?: string;
  closedAt?: string;
  metadata?: Record<string, unknown>;
  members?: ChannelMemberInput[];
}

export type ChannelAddressingReason =
  | "legacy-no-channel"
  | "channel-not-found"
  | "channel-closed"
  | "self-not-member"
  | "sender-not-member"
  | "channel-broadcast"
  | "addressee-not-member"
  | "addressed-member"
  | "observer-muted";

export interface ChannelAddressingInput {
  channelId?: string;
  selfAgentId: string;
  senderAgentId?: string;
  senderMemberId?: string;
  addresseeMemberId?: string;
  addresseeAgentId?: string;
}

export interface ChannelAddressingDecision {
  allowAppend: boolean;
  allowWake: boolean;
  reject: boolean;
  reason: ChannelAddressingReason;
  channel?: ChannelRecord;
  selfMember?: ChannelMemberRecord;
  senderMember?: ChannelMemberRecord;
  addresseeMember?: ChannelMemberRecord;
}

export interface ChannelThreadStartBindingInput {
  member: ChannelMemberRecord;
  baseInstructions?: string | null;
}

export interface ChannelThreadStartBinding {
  model: string | null;
  personality: string | null;
  baseInstructions: string | null;
  metadata: {
    murmur_channel_id: string;
    murmur_member_id: string;
    murmur_agent_id: string;
    murmur_member_slot?: string;
    murmur_persona_id?: string;
    murmur_model?: string;
    murmur_base_instructions_hash?: string;
  };
}

export const buildChannelThreadStartBinding = ({ member, baseInstructions = null }: ChannelThreadStartBindingInput): ChannelThreadStartBinding => ({
  model: member.model ?? null,
  personality: member.personaId ?? null,
  baseInstructions,
  metadata: {
    murmur_channel_id: member.channelId,
    murmur_member_id: member.memberId,
    murmur_agent_id: member.agentId,
    ...(member.memberSlot ? { murmur_member_slot: member.memberSlot } : {}),
    ...(member.personaId ? { murmur_persona_id: member.personaId } : {}),
    ...(member.model ? { murmur_model: member.model } : {}),
    ...(member.baseInstructionsHash ? { murmur_base_instructions_hash: member.baseInstructionsHash } : {}),
  },
});

const DDL = `
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=10000;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('dm', 'group', 'consult')),
    created_at TEXT NOT NULL,
    closed_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_channels_conversation ON channels(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_slot TEXT,
    agent_id TEXT NOT NULL,
    role TEXT,
    persona_id TEXT,
    model TEXT,
    base_instructions_hash TEXT,
    eligibility_json TEXT NOT NULL DEFAULT '{}',
    joined_at TEXT NOT NULL,
    left_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (channel_id, member_id),
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);
  CREATE INDEX IF NOT EXISTS idx_channel_members_slot ON channel_members(channel_id, member_slot);
  CREATE INDEX IF NOT EXISTS idx_channel_members_persona ON channel_members(persona_id);

  CREATE TABLE IF NOT EXISTS channel_session_presence (
    channel_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'busy')),
    joined_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, member_id, session_id),
    FOREIGN KEY (channel_id, member_id) REFERENCES channel_members(channel_id, member_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_channel_presence_expiry ON channel_session_presence(expires_at);
`;

const jsonObject = (value?: Record<string, unknown>): string => JSON.stringify(value ?? {});

const validatePresenceIdentity = (input: ChannelSessionIdentity): void => {
  for (const value of [input.channelId, input.memberId, input.agentId, input.sessionId]) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256) throw new Error("presence-identity-invalid");
  }
};

const validatePresenceClock = (now: number): void => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("presence-clock-invalid");
};

const parseJsonObject = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export class ChannelRosterStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = ".data/channel-roster.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(DDL);
  }

  createChannel(input: CreateChannelInput): ChannelRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO channels (channel_id, conversation_id, type, created_at, closed_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.channelId, input.conversationId, input.type, createdAt, input.closedAt ?? null, jsonObject(input.metadata));

      for (const member of input.members ?? []) {
        this.insertChannelMember(input.channelId, member, createdAt, false);
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const channel = this.getChannel(input.channelId);
    if (!channel) throw new Error(`channel create failed: ${input.channelId}`);
    return channel;
  }

  getChannel(channelId: string): ChannelRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           channel_id as channelId,
           conversation_id as conversationId,
           type,
           created_at as createdAt,
           closed_at as closedAt,
           metadata_json as metadataJson
         FROM channels
         WHERE channel_id = ?`,
      )
      .get(channelId) as
      | { channelId: string; conversationId: string; type: ChannelType; createdAt: string; closedAt?: string | null; metadataJson: string }
      | undefined;
    return row ? this.toChannelRecord(row) : null;
  }

  listChannelsForConversation(conversationId: string): ChannelRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
           channel_id as channelId,
           conversation_id as conversationId,
           type,
           created_at as createdAt,
           closed_at as closedAt,
           metadata_json as metadataJson
         FROM channels
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as Array<{ channelId: string; conversationId: string; type: ChannelType; createdAt: string; closedAt?: string | null; metadataJson: string }>;
    return rows.map((row) => this.toChannelRecord(row));
  }

  listChannelMembers(channelId: string): ChannelMemberRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
           channel_id as channelId,
           member_id as memberId,
           member_slot as memberSlot,
           agent_id as agentId,
           role,
           persona_id as personaId,
           model,
           base_instructions_hash as baseInstructionsHash,
           eligibility_json as eligibilityJson,
           joined_at as joinedAt,
           left_at as leftAt,
           metadata_json as metadataJson
         FROM channel_members
         WHERE channel_id = ?
         ORDER BY member_id ASC`,
      )
      .all(channelId) as Array<{
      channelId: string;
      memberId: string;
      memberSlot?: string | null;
      agentId: string;
      role?: string | null;
      personaId?: string | null;
      model?: string | null;
      baseInstructionsHash?: string | null;
      eligibilityJson: string;
      joinedAt: string;
      leftAt?: string | null;
      metadataJson: string;
    }>;
    return rows.map((row) => this.toChannelMemberRecord(row));
  }

  getChannelMember(channelId: string, memberId: string): ChannelMemberRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           channel_id as channelId,
           member_id as memberId,
           member_slot as memberSlot,
           agent_id as agentId,
           role,
           persona_id as personaId,
           model,
           base_instructions_hash as baseInstructionsHash,
           eligibility_json as eligibilityJson,
           joined_at as joinedAt,
           left_at as leftAt,
           metadata_json as metadataJson
         FROM channel_members
         WHERE channel_id = ? AND member_id = ?`,
      )
      .get(channelId, memberId) as
      | {
        channelId: string;
        memberId: string;
        memberSlot?: string | null;
        agentId: string;
        role?: string | null;
        personaId?: string | null;
        model?: string | null;
        baseInstructionsHash?: string | null;
        eligibilityJson: string;
        joinedAt: string;
        leftAt?: string | null;
        metadataJson: string;
      }
      | undefined;
    return row ? this.toChannelMemberRecord(row) : null;
  }

  findActiveMembersForAgent(agentId: string): ChannelMemberRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
           channel_id as channelId,
           member_id as memberId,
           member_slot as memberSlot,
           agent_id as agentId,
           role,
           persona_id as personaId,
           model,
           base_instructions_hash as baseInstructionsHash,
           eligibility_json as eligibilityJson,
           joined_at as joinedAt,
           left_at as leftAt,
           metadata_json as metadataJson
         FROM channel_members
         WHERE agent_id = ? AND left_at IS NULL
         ORDER BY joined_at ASC`,
      )
      .all(agentId) as Array<{
      channelId: string;
      memberId: string;
      memberSlot?: string | null;
      agentId: string;
      role?: string | null;
      personaId?: string | null;
      model?: string | null;
      baseInstructionsHash?: string | null;
      eligibilityJson: string;
      joinedAt: string;
      leftAt?: string | null;
      metadataJson: string;
    }>;
    return rows.map((row) => this.toChannelMemberRecord(row));
  }

  findActiveChannelMemberForAgent(channelId: string, agentId: string): ChannelMemberRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           channel_id as channelId,
           member_id as memberId,
           member_slot as memberSlot,
           agent_id as agentId,
           role,
           persona_id as personaId,
           model,
           base_instructions_hash as baseInstructionsHash,
           eligibility_json as eligibilityJson,
           joined_at as joinedAt,
           left_at as leftAt,
           metadata_json as metadataJson
         FROM channel_members
         WHERE channel_id = ? AND agent_id = ? AND left_at IS NULL
         ORDER BY joined_at ASC
         LIMIT 1`,
      )
      .get(channelId, agentId) as
      | {
        channelId: string;
        memberId: string;
        memberSlot?: string | null;
        agentId: string;
        role?: string | null;
        personaId?: string | null;
        model?: string | null;
        baseInstructionsHash?: string | null;
        eligibilityJson: string;
        joinedAt: string;
        leftAt?: string | null;
        metadataJson: string;
      }
      | undefined;
    return row ? this.toChannelMemberRecord(row) : null;
  }

  isChannelMember(channelId: string, agentId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ? AND left_at IS NULL LIMIT 1`)
      .get(channelId, agentId) as { "1": number } | undefined;
    return row !== undefined;
  }

  evaluateAddressing(input: ChannelAddressingInput): ChannelAddressingDecision {
    if (!input.channelId) {
      return { allowAppend: true, allowWake: true, reject: false, reason: "legacy-no-channel" };
    }

    const channel = this.getChannel(input.channelId);
    if (!channel) {
      return { allowAppend: false, allowWake: false, reject: true, reason: "channel-not-found" };
    }
    if (channel.closedAt) {
      return { allowAppend: false, allowWake: false, reject: true, reason: "channel-closed", channel };
    }

    const selfMember = this.findActiveChannelMemberForAgent(input.channelId, input.selfAgentId);
    if (!selfMember) {
      return { allowAppend: false, allowWake: false, reject: true, reason: "self-not-member", channel };
    }

    const senderMember = input.senderMemberId
      ? this.getChannelMember(input.channelId, input.senderMemberId)
      : input.senderAgentId
        ? this.findActiveChannelMemberForAgent(input.channelId, input.senderAgentId)
        : undefined;
    if (input.senderAgentId && (!senderMember || senderMember.leftAt || senderMember.agentId !== input.senderAgentId)) {
      return { allowAppend: false, allowWake: false, reject: true, reason: "sender-not-member", channel, selfMember };
    }

    if (!input.addresseeMemberId && !input.addresseeAgentId) {
      return { allowAppend: true, allowWake: true, reject: false, reason: "channel-broadcast", channel, selfMember, ...(senderMember ? { senderMember } : {}) };
    }

    const addresseeMember = input.addresseeMemberId
      ? this.getChannelMember(input.channelId, input.addresseeMemberId)
      : this.findActiveChannelMemberForAgent(input.channelId, input.addresseeAgentId ?? "");
    if (!addresseeMember || addresseeMember.leftAt) {
      return { allowAppend: false, allowWake: false, reject: true, reason: "addressee-not-member", channel, selfMember, ...(senderMember ? { senderMember } : {}) };
    }

    const isAddressed = addresseeMember.agentId === input.selfAgentId;
    return {
      allowAppend: true,
      allowWake: isAddressed,
      reject: false,
      reason: isAddressed ? "addressed-member" : "observer-muted",
      channel,
      selfMember,
      ...(senderMember ? { senderMember } : {}),
      addresseeMember,
    };
  }

  upsertChannelMember(channelId: string, member: ChannelMemberInput): ChannelMemberRecord {
    this.insertChannelMember(channelId, member, new Date().toISOString(), true);
    const found = this.getChannelMember(channelId, member.memberId);
    if (!found) throw new Error(`channel member upsert failed: ${channelId}/${member.memberId}`);
    return found;
  }

  closeChannel(channelId: string, closedAt = new Date().toISOString()): boolean {
    const result = this.db
      .prepare(`UPDATE channels SET closed_at = ? WHERE channel_id = ? AND closed_at IS NULL`)
      .run(closedAt, channelId);
    return result.changes > 0;
  }

  heartbeatChannelSession(input: ChannelSessionHeartbeat): ChannelSessionPresence {
    validatePresenceIdentity(input);
    const now = input.now ?? Date.now();
    validatePresenceClock(now);
    const ttlMs = input.ttlMs ?? 30000;
    if (!Number.isInteger(ttlMs) || ttlMs < 5000 || ttlMs > 300000) throw new Error("presence-ttl-invalid");
    const status = input.status ?? "active";
    if (!["active", "idle", "busy"].includes(status)) throw new Error("presence-status-invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const channel = this.getChannel(input.channelId);
      if (!channel || channel.closedAt) throw new Error("presence-channel-inactive");
      const member = this.getChannelMember(input.channelId, input.memberId);
      if (!member || member.leftAt || member.agentId !== input.agentId) throw new Error("presence-member-inactive-or-mismatched");
      this.db.prepare("DELETE FROM channel_session_presence WHERE expires_at <= ?").run(now);
      this.db.prepare(`INSERT INTO channel_session_presence
        (channel_id, member_id, agent_id, session_id, status, joined_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, member_id, session_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          status = excluded.status,
          joined_at = CASE WHEN agent_id = excluded.agent_id THEN joined_at ELSE excluded.joined_at END,
          heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`)
        .run(input.channelId, input.memberId, input.agentId, input.sessionId, status, now, now, now + ttlMs);
      const row = this.listChannelPresence(input.channelId, { now }).find((p) => p.memberId === input.memberId && p.sessionId === input.sessionId);
      if (!row) throw new Error("presence-write-failed");
      this.db.exec("COMMIT");
      return row;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** A live row is descriptive only: never consult this table to authorize a wake. */
  listChannelPresence(channelId: string, { now = Date.now() }: { now?: number } = {}): ChannelSessionPresence[] {
    validatePresenceClock(now);
    return this.db.prepare(`SELECT p.channel_id AS channelId, c.conversation_id AS conversationId,
        p.member_id AS memberId, p.agent_id AS agentId, p.session_id AS sessionId,
        p.status, p.joined_at AS joinedAt, p.heartbeat_at AS heartbeatAt, p.expires_at AS expiresAt
      FROM channel_session_presence p
      JOIN channels c ON c.channel_id = p.channel_id AND c.closed_at IS NULL
      JOIN channel_members m ON m.channel_id = p.channel_id AND m.member_id = p.member_id
        AND m.agent_id = p.agent_id AND m.left_at IS NULL
      WHERE p.channel_id = ? AND p.expires_at > ?
      ORDER BY p.member_id, p.session_id`).all(channelId, now) as unknown as ChannelSessionPresence[];
  }

  leaveChannelSession(input: ChannelSessionIdentity): boolean {
    validatePresenceIdentity(input);
    return Number(this.db.prepare(`DELETE FROM channel_session_presence
      WHERE channel_id = ? AND member_id = ? AND agent_id = ? AND session_id = ?`)
      .run(input.channelId, input.memberId, input.agentId, input.sessionId).changes) > 0;
  }

  close(): void {
    this.db.close();
  }

  private insertChannelMember(channelId: string, member: ChannelMemberInput, defaultJoinedAt: string, upsert: boolean): void {
    const joinedAt = member.joinedAt ?? defaultJoinedAt;
    if (upsert) {
      this.db
        .prepare(
          `INSERT INTO channel_members
           (channel_id, member_id, member_slot, agent_id, role, persona_id, model, base_instructions_hash, eligibility_json, joined_at, left_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, member_id) DO UPDATE SET
             member_slot = excluded.member_slot,
             agent_id = excluded.agent_id,
             role = excluded.role,
             persona_id = excluded.persona_id,
             model = excluded.model,
             base_instructions_hash = excluded.base_instructions_hash,
             eligibility_json = excluded.eligibility_json,
             left_at = excluded.left_at,
             metadata_json = excluded.metadata_json`,
        )
        .run(
          channelId,
          member.memberId,
          member.memberSlot ?? null,
          member.agentId,
          member.role ?? null,
          member.personaId ?? null,
          member.model ?? null,
          member.baseInstructionsHash ?? null,
          jsonObject(member.eligibility),
          joinedAt,
          member.leftAt ?? null,
          jsonObject(member.metadata),
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO channel_members
         (channel_id, member_id, member_slot, agent_id, role, persona_id, model, base_instructions_hash, eligibility_json, joined_at, left_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        channelId,
        member.memberId,
        member.memberSlot ?? null,
        member.agentId,
        member.role ?? null,
        member.personaId ?? null,
        member.model ?? null,
        member.baseInstructionsHash ?? null,
        jsonObject(member.eligibility),
        joinedAt,
        member.leftAt ?? null,
        jsonObject(member.metadata),
      );
  }

  private toChannelRecord(row: { channelId: string; conversationId: string; type: ChannelType; createdAt: string; closedAt?: string | null; metadataJson: string }): ChannelRecord {
    return {
      channelId: row.channelId,
      conversationId: row.conversationId,
      type: row.type,
      createdAt: row.createdAt,
      ...(row.closedAt ? { closedAt: row.closedAt } : {}),
      metadata: parseJsonObject(row.metadataJson),
    };
  }

  private toChannelMemberRecord(row: {
    channelId: string;
    memberId: string;
    memberSlot?: string | null;
    agentId: string;
    role?: string | null;
    personaId?: string | null;
    model?: string | null;
    baseInstructionsHash?: string | null;
    eligibilityJson: string;
    joinedAt: string;
    leftAt?: string | null;
    metadataJson: string;
  }): ChannelMemberRecord {
    return {
      channelId: row.channelId,
      memberId: row.memberId,
      ...(row.memberSlot ? { memberSlot: row.memberSlot } : {}),
      agentId: row.agentId,
      ...(row.role ? { role: row.role } : {}),
      ...(row.personaId ? { personaId: row.personaId } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.baseInstructionsHash ? { baseInstructionsHash: row.baseInstructionsHash } : {}),
      joinedAt: row.joinedAt,
      ...(row.leftAt ? { leftAt: row.leftAt } : {}),
      eligibility: parseJsonObject(row.eligibilityJson),
      metadata: parseJsonObject(row.metadataJson),
    };
  }
}
