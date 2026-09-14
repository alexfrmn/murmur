import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNotifyTargets, targetsForSender } from "../scripts/notify-router.mjs";

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

test("an empty peers list means no filter, not a target nobody reaches", () => {
  const targets = normalizeNotifyTargets({ telegram: [{ botToken: "t", chatId: "1", peers: [] }] });
  assert.equal(targets[0].peers, undefined);
  assert.equal(targetsForSender(targets, "agent-jarvis").length, 1);
});

test("webhook targets take the same filter", () => {
  const targets = normalizeNotifyTargets({
    webhook: [{ channel: "ops", url: "https://example.invalid/hook", peers: ["agent-sasha"] }],
  });
  assert.deepEqual(targetsForSender(targets, "agent-sasha").map((t) => t.channel), ["ops"]);
  assert.deepEqual(targetsForSender(targets, "agent-jarvis"), []);
});
