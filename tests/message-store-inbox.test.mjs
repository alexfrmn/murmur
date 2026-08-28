import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";

const withStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-inbox-"));
  const store = new SQLiteMessageStore(join(dir, "murmur.db"));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const append = (store, { direction, sender, text, at }) =>
  store.append({
    conversationId: "peer:task:test",
    msgId: `${direction}-${text.slice(0, 8)}-${at}`,
    direction,
    sender,
    text,
    createdAt: at,
  });

test("listInbound returns delivered inbound messages that never mention the agent", async () => {
  const { store, cleanup } = withStore();
  try {
    // The regression from #114: none of these three spell out the receiving agent's
    // name, which is the normal case for a reply.
    await append(store, { direction: "inbound", sender: "agent-peer", text: "done, deployed", at: "2026-08-26T22:00:00.000Z" });
    await append(store, { direction: "inbound", sender: "agent-peer", text: "logs look clean", at: "2026-08-26T22:01:00.000Z" });
    await append(store, { direction: "outbound", sender: "agent-claude", text: "check the logs", at: "2026-08-26T22:02:00.000Z" });

    const inbound = await store.listInbound(20);

    assert.equal(inbound.length, 2);
    assert.ok(inbound.every((m) => m.direction === "inbound"));
    assert.deepEqual(inbound.map((m) => m.text), ["logs look clean", "done, deployed"]);
  } finally {
    cleanup();
  }
});

test("the old searchMessages(agentId) form is what dropped them", async () => {
  const { store, cleanup } = withStore();
  try {
    await append(store, { direction: "inbound", sender: "agent-peer", text: "done, deployed", at: "2026-08-26T22:00:00.000Z" });

    // Guards the reason for the fix rather than the fix itself: a LIKE over
    // text/sender/conversationId cannot see a message that does not name the agent,
    // and the tool reported count:0 while the sender saw the message acked.
    const viaSearch = await store.searchMessages("agent-claude", 100);
    assert.equal(viaSearch.length, 0);

    const viaInbox = await store.listInbound(20);
    assert.equal(viaInbox.length, 1);
  } finally {
    cleanup();
  }
});

test("listInbound honours the limit and returns newest first", async () => {
  const { store, cleanup } = withStore();
  try {
    for (let i = 0; i < 5; i += 1) {
      await append(store, {
        direction: "inbound",
        sender: "agent-peer",
        text: `msg ${i}`,
        at: `2026-08-26T22:0${i}:00.000Z`,
      });
    }

    const inbound = await store.listInbound(2);

    assert.equal(inbound.length, 2);
    assert.deepEqual(inbound.map((m) => m.text), ["msg 4", "msg 3"]);
  } finally {
    cleanup();
  }
});
