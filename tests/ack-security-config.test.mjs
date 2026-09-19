import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAckSecurity } from "../scripts/ack-security.mjs";

test("daemon defaults to signed emission and verification with visible effective policy", () => {
  assert.deepEqual(normalizeAckSecurity({}, {}), {
    emitSigned: true, requireSigned: true, requestedRequireSigned: true, unsignedAction: "ignore",
  });
});

test("explicit legacy signature downgrade warns but never permits unsigned mutations", () => {
  for (const [config, env] of [
    [{ ackSecurity: { requireSigned: false } }, {}],
    [{}, { MURMUR_REQUIRE_SIGNED_ACKS: "0" }],
  ]) {
    const logs = [];
    const policy = normalizeAckSecurity(config, env, (...args) => logs.push(args));
    assert.equal(policy.requireSigned, true);
    assert.equal(policy.requestedRequireSigned, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], "warn");
    assert.equal(logs[0][2].reason, "unsigned-acks-cannot-settle-outbox");
  }
});

test("outbound unsigned mode requires an explicit valid flag and warns about ignored receipts", () => {
  const logs = [];
  const policy = normalizeAckSecurity({ ackSecurity: { emitSigned: true } },
    { MURMUR_EMIT_SIGNED_ACKS: "false" }, (...args) => logs.push(args));
  assert.equal(policy.emitSigned, false);
  assert.equal(policy.requireSigned, true);
  assert.equal(logs[0][2].reason, "upgraded-peers-will-ignore-delivery-acks");
  for (const value of [null, 0, "false", "yes"]) {
    assert.throws(() => normalizeAckSecurity({ ackSecurity: { requireSigned: value } }, {}), /ack-security-invalid/);
  }
  assert.throws(() => normalizeAckSecurity({}, { MURMUR_REQUIRE_SIGNED_ACKS: "typo" }), /ack-security-invalid/);
});
