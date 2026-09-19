import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createKeyPair, createSigningKeyPair } from "../packages/security/dist/src/index.js";
import { channelScopedSubject } from "../packages/core/dist/src/index.js";

// #105 — the relay reply must be re-sendable under the same id. `--msg-id` lets the
// Codex wake path mint the reply id from the inbound msgId, and a second run with that
// id is a no-op: one outbox row, one local copy, exit 0 both times.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "murmur-shell-send.mjs");

const setup = async (subjectScoping) => {
  const dir = mkdtempSync(path.join(tmpdir(), "murmur-shell-send-"));
  const dataDir = path.join(dir, ".data");
  mkdirSync(dataDir, { mode: 0o700 });
  const encryption = await createKeyPair();
  const signing = await createSigningKeyPair();
  const peerEncryption = await createKeyPair();
  const peerSigning = await createSigningKeyPair();
  const config = {
    agentId: "agent-codex",
    subject: "msg.agent-codex",
    keys: { encryption, signing },
    peers: {
      "agent-jarvis": {
        subject: "msg.agent-jarvis",
        ...(subjectScoping === undefined ? {} : { subjectScoping }),
        encryption: { publicKey: peerEncryption.publicKey },
        signing: { publicKey: peerSigning.publicKey },
      },
    },
  };
  const configPath = path.join(dataDir, "agent-config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { dir, dataDir, dbPath: path.join(dataDir, "murmur.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const send = (dataDir, args) =>
  JSON.parse(
    execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
    }).trim(),
  );

test("murmur-shell-send accepts --msg-id and a repeat with the same id enqueues nothing new", async () => {
  const { dataDir, dbPath, cleanup } = await setup();
  try {
    const msgId = "11111111-2222-4333-8444-555555555555";
    const first = send(dataDir, ["--to", "agent-jarvis", "--conv", "dm:agent-codex:agent-jarvis", "--text", "reply once", "--msg-id", msgId]);
    const second = send(dataDir, ["--to", "agent-jarvis", "--conv", "dm:agent-codex:agent-jarvis", "--text", "reply once", "--msg-id", msgId]);

    assert.equal(first.msgId, msgId);
    assert.equal(first.status, "queued");
    assert.equal(second.msgId, msgId);
    assert.equal(second.status, "already-queued");

    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) as n FROM outbox WHERE msg_id = ?").get(msgId).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) as n FROM local_messages WHERE msg_id = ?").get(msgId).n, 1);
  } finally {
    cleanup();
  }
});

test("murmur-shell-send rejects a --msg-id that is not a UUID", async () => {
  const { dataDir, cleanup } = await setup();
  try {
    assert.throws(
      () => send(dataDir, ["--to", "agent-jarvis", "--text", "x", "--msg-id", "not-a-uuid"]),
      (err) => err.status === 1 && /msg-id/.test(String(err.stderr)),
    );
  } finally {
    cleanup();
  }
});

test("shell sender scopes structured traffic only after peer opt-in", async () => {
  for (const enabled of [undefined, true]) {
    const { dataDir, dbPath, cleanup } = await setup(enabled);
    try {
      const result = send(dataDir, ["--to", "agent-jarvis", "--text", "scoped", "--channel", "c.with.dots", "--sender-member", "sender"]);
      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT subject,envelope_json FROM outbox WHERE msg_id=?").get(result.msgId);
        assert.equal(row.subject, enabled ? channelScopedSubject("msg.agent-jarvis", "c.with.dots") : "msg.agent-jarvis");
        assert.equal(JSON.parse(row.envelope_json).channelId, "c.with.dots");
      } finally { db.close(); }
    } finally { cleanup(); }
  }
});
