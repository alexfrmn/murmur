import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

test("MCP presence binds identities, supports multiple sessions, leave and crash expiry", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-presence-mcp-"));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "agent-config.json"), JSON.stringify({ agentId: "agent-a", memberId: "self", peers: {} }), { mode: 0o600 });
  const client = (sessionId) => {
    const proc = spawn(process.execPath, ["packages/mcp-server/dist/src/index.js"], {
      env: { ...process.env, DATA_DIR: dir, MURMUR_STORE_PATH: join(dir, "murmur.db"), MURMUR_CHANNEL_ROSTER_PATH: join(dir, "channel-roster.db"), MURMUR_SESSION_ID: sessionId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(proc);
    const responses = new Map();
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => { const r = JSON.parse(line); responses.get(r.id)?.(r); });
    let counter = 0;
    return {
      proc,
      async call(name, args, expectedError) {
        const id = ++counter;
        const pending = new Promise((resolve) => responses.set(id, resolve));
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
        const response = await pending; responses.delete(id);
        if (expectedError) { assert.match(response.error?.message ?? "", expectedError); return; }
        assert.equal(response.error, undefined, response.error?.message);
        return JSON.parse(response.result.content[0].text);
      },
    };
  };
  const a = client("chat-a");
  await a.call("channel_create", { channelId: "c", conversationId: "history", type: "group", members: [{ memberId: "self", agentId: "agent-a" }, { memberId: "peer", agentId: "agent-b" }] });
  const b = client("chat-b");
  const first = await a.call("channel_presence_heartbeat", { channelId: "c", ttlMs: 5000 });
  assert.equal(first.presence.agentId, "agent-a");
  assert.equal(first.presence.sessionId, "chat-a");
  await b.call("channel_presence_heartbeat", { channelId: "c", status: "busy", ttlMs: 5000 });
  assert.equal((await a.call("channel_presence", { channelId: "c" })).sessions.length, 2);
  await a.call("channel_presence_heartbeat", { channelId: "c", agentId: "agent-b" }, /identity is bound/);
  await a.call("channel_presence_leave", { channelId: "c", sessionId: "chat-b" }, /identity is bound/);
  await a.call("channel_presence_heartbeat", { channelId: "c", memberId: "peer" }, /presence-member/);
  assert.equal((await a.call("channel_presence_leave", { channelId: "c" })).left, true);
  const exited = once(b.proc, "exit"); b.proc.kill("SIGKILL"); await exited;
  // Accelerate wall clock via a separate store API instead of a five-second sleep.
  const { ChannelRosterStore } = await import("../packages/core/dist/src/index.js");
  const observer = new ChannelRosterStore(join(dir, "channel-roster.db"));
  try {
    assert.equal(observer.listChannelPresence("c").length, 1);
    assert.deepEqual(observer.listChannelPresence("c", { now: Date.now() + 5000 }), []);
  } finally { observer.close(); }
});
