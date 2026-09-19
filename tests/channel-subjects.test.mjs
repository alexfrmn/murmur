import test from "node:test";
import assert from "node:assert/strict";
import { channelScopedSubject, channelSubjectRoutes, resolveMessageSubject, subjectMatchesFilter } from "../packages/core/dist/src/index.js";

test("scoped subject uses one collision-free literal channel token", () => {
  const channels = ["a.b", "a/b", "a_b", "a*b", "a>b", "канал:1"];
  const subjects = channels.map((c) => channelScopedSubject("msg.agent", c));
  assert.equal(new Set(subjects).size, channels.length);
  for (let i = 0; i < channels.length; i++) {
    assert.equal(subjects[i].split(".").length, 3);
    assert.equal(Buffer.from(subjects[i].split(".")[2].slice(2), "base64url").toString(), channels[i]);
    assert.ok(!/[\s*>]/.test(subjects[i]));
  }
  assert.throws(() => channelScopedSubject("msg.agent.>", "c"), /invalid-base/);
  assert.throws(() => channelScopedSubject("msg.agent", ""), /invalid-channel/);
});

test("publisher opt-in preserves fieldless and default legacy sends", () => {
  assert.equal(resolveMessageSubject({ subject: "msg.a" }, "c"), "msg.a");
  assert.equal(resolveMessageSubject({ subject: "msg.a", subjectScoping: true }), "msg.a");
  assert.equal(resolveMessageSubject({ subject: "msg.a", subjectScoping: true }, "c"), channelScopedSubject("msg.a", "c"));
  assert.throws(() => resolveMessageSubject({ subject: "msg.a", subjectScoping: "true" }, "c"), /invalid-flag/);
});

test("migration adds stable distinct durables while retaining the exact legacy consumer", () => {
  const routes = channelSubjectRoutes("msg.a", "receiver", { enabled: true, channelIds: ["c1", "c2"] });
  assert.deepEqual(routes[0], { subject: "msg.a", durableName: "receiver" });
  assert.notEqual(routes[1].durableName, routes[2].durableName);
  assert.equal(channelSubjectRoutes("msg.a", "receiver", { enabled: true, channelIds: ["c2", "c1"] })[2].durableName, routes[1].durableName);
  assert.deepEqual(channelSubjectRoutes("msg.a", "receiver"), [routes[0]]);
  assert.throws(() => channelSubjectRoutes("msg.a", "receiver", { enabled: true, channelIds: ["c", "c"] }), /duplicate-channel/);
});

test("NATS stream coverage honors token and trailing wildcard boundaries", () => {
  assert.equal(subjectMatchesFilter("msg.a", "msg.>"), true);
  assert.equal(subjectMatchesFilter("msg.a.c", "msg.>"), true);
  assert.equal(subjectMatchesFilter("msg.a.c", "msg.*"), false);
  assert.equal(subjectMatchesFilter("msg.a", "msg.a.>"), false);
  assert.equal(subjectMatchesFilter("msg.a.c", "msg.*.*"), true);
  assert.equal(subjectMatchesFilter("msg.a.c", "msg.b.>"), false);
});
