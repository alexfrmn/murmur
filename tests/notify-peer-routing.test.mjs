import test from "node:test";
import assert from "node:assert/strict";
import { NotifyQueue, enqueuePeerNotification, normalizeNotifyTargets, targetsForSender } from "../scripts/notify-router.mjs";

const cfg = {
  telegram: [
    { channel: "jarvis", botToken: "t", chatId: "-100", topicId: 2, peers: ["agent-jarvis"] },
    { channel: "sasha", botToken: "t", chatId: "-100", topicId: 3, peers: ["agent-sasha"] },
    { channel: "general", botToken: "t", chatId: "-100", topicId: 1, fallback: true },
  ],
};

test("a target keeps its peer filter, a target without one stays catch-all", () => {
  const targets = normalizeNotifyTargets(cfg);
  assert.equal(targets.length, 3);
  assert.deepEqual(targets[0].peers, ["agent-jarvis"]);
  assert.equal(targets[2].peers, undefined);
});

test("a message goes to its own thread and nowhere else", () => {
  const targets = normalizeNotifyTargets(cfg);
  assert.deepEqual(targetsForSender(targets, "agent-jarvis").map((t) => t.channel), ["jarvis"]);
  assert.deepEqual(targetsForSender(targets, "agent-sasha").map((t) => t.channel), ["sasha"]);
});

test("a peer with no thread of its own lands in the fallback", () => {
  const targets = normalizeNotifyTargets(cfg);
  assert.deepEqual(targetsForSender(targets, "agent-viola").map((t) => t.channel), ["general"]);
});

test("a plain target without peers still gets everything, next to the threads", () => {
  const targets = normalizeNotifyTargets({
    telegram: [
      { channel: "jarvis", botToken: "t", chatId: "-100", topicId: 2, peers: ["agent-jarvis"] },
      { channel: "dm", botToken: "t", chatId: "309958852" },
      { channel: "general", botToken: "t", chatId: "-100", topicId: 1, fallback: true },
    ],
  });
  assert.deepEqual(targetsForSender(targets, "agent-jarvis").map((t) => t.channel), ["jarvis", "dm"]);
  assert.deepEqual(targetsForSender(targets, "agent-viola").map((t) => t.channel), ["dm", "general"]);
});

test("agent ids match case-insensitively and tolerate stray spaces", () => {
  const targets = normalizeNotifyTargets({
    telegram: [{ channel: "jarvis", botToken: "t", chatId: "-100", peers: [" Agent-JARVIS "] }],
  });
  assert.deepEqual(targetsForSender(targets, "agent-jarvis").map((t) => t.channel), ["jarvis"]);
  assert.deepEqual(targetsForSender(targets, "agent-sasha"), []);
});

test("an existing config without peers keeps receiving everything", () => {
  const targets = normalizeNotifyTargets({ botToken: "t", chatId: "309958852" });
  assert.equal(targets.length, 1);
  assert.equal(targetsForSender(targets, "agent-jarvis").length, 1);
  assert.equal(targetsForSender(targets, "").length, 1);
});

test("an explicit empty peers list accepts nobody instead of becoming catch-all", () => {
  const targets = normalizeNotifyTargets({ telegram: [{ botToken: "t", chatId: "1", peers: [] }] });
  assert.deepEqual(targets[0].peers, []);
  assert.equal(targetsForSender(targets, "agent-jarvis").length, 0);
});

test("bare Telegram and webhook configs preserve their declared peer filters", () => {
  for (const cfg of [
    { botToken: "t", chatId: "1", peers: ["agent-jarvis"] },
    { url: "https://example.invalid/hook", peers: ["agent-jarvis"] },
  ]) {
    const targets = normalizeNotifyTargets(cfg);
    assert.equal(targetsForSender(targets, "agent-jarvis").length, 1);
    assert.equal(targetsForSender(targets, "agent-other").length, 0);
  }
});

test("an empty filter does not suppress a separate fallback target", () => {
  const targets = normalizeNotifyTargets({ telegram: [
    { channel: "disabled", botToken: "t", chatId: "1", peers: [] },
    { channel: "fallback", botToken: "t", chatId: "1", fallback: true },
  ] });
  assert.deepEqual(targetsForSender(targets, "agent-jarvis").map((x) => x.channel), ["fallback"]);
});

test("webhook targets take the same filter", () => {
  const targets = normalizeNotifyTargets({
    webhook: [{ channel: "ops", url: "https://example.invalid/hook", peers: ["agent-sasha"] }],
  });
  assert.deepEqual(targetsForSender(targets, "agent-sasha").map((t) => t.channel), ["ops"]);
  assert.deepEqual(targetsForSender(targets, "agent-jarvis"), []);
});

for (const reason of [undefined, "native-wake-failed"]) {
  test(`notification ${reason ?? "normal"}: unmatched peer is logged with safe diagnostic fields`, (t) => {
    const queue = new NotifyQueue(":memory:");
    t.after(() => queue.db.close());
    const lines = [];
    const targets = normalizeNotifyTargets({ telegram: [cfg.telegram[0]] });
    assert.equal(enqueuePeerNotification({
      queue, targets, reason,
      payload: { msgId: "unmatched", from: "agent-other", text: "private-message" },
      log: (level, msg, fields) => lines.push({ level, msg, fields }),
    }), 0);
    assert.equal(queue.pendingCount(), 0);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "warn");
    assert.equal(lines[0].fields.msgId, "unmatched");
    assert.equal(lines[0].fields.from, "agent-other");
    assert.equal(lines[0].fields.reason, reason);
    assert.ok(!JSON.stringify(lines).includes("private-message"));
    assert.ok(!JSON.stringify(lines).includes("botToken"));
  });

  test(`notification ${reason ?? "normal"}: only the intended agent's thread is queued`, (t) => {
    const queue = new NotifyQueue(":memory:");
    t.after(() => queue.db.close());
    const payload = { msgId: "matched", from: "agent-jarvis", senderMemberId: "a-human", text: "hello" };
    const args = { queue, targets: normalizeNotifyTargets(cfg), payload, reason, log() {} };
    assert.equal(enqueuePeerNotification(args), 1);
    enqueuePeerNotification(args);
    const rows = queue.claimDue();
    assert.equal(rows.length, 1, "same message and target retain queue deduplication");
    assert.equal(rows[0].channel_name, "jarvis");
    assert.equal(JSON.parse(rows[0].target_json).topicId, 2);
    assert.equal(JSON.parse(rows[0].payload_json).senderMemberId, "a-human");
    assert.equal(JSON.parse(rows[0].payload_json).text, reason ? `[WakeMonitor ${reason}] hello` : "hello");
    enqueuePeerNotification({ ...args, payload: { ...payload, msgId: "muted", wakeEligible: false } });
    assert.equal(queue.pendingCount(), 1, "observer-muted traffic remains muted");
  });
}
