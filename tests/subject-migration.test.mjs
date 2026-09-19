import test from "node:test";
import assert from "node:assert/strict";
import { AckPolicy } from "nats";
import { planSubjectMigration, prepareSubjectMigration, checkSubjectRollback } from "../scripts/subject-migration.mjs";

const input = { stream: "MURMUR", subject: "msg.agent", consumerId: "agent", channelIds: ["c"] };
const missing = () => { throw Object.assign(new Error("missing"), { code: "404" }); };
const manager = (consumers = {}) => ({ streams: { info: async () => ({ config: { subjects: ["msg.>"] } }) }, consumers: { info: async () => missing(), ...consumers } });

test("migration refuses stream gaps, incompatible consumers and authorization errors before writes", async () => {
  const gap = manager(); gap.streams.info = async () => ({ config: { subjects: ["msg.agent"] } });
  await assert.rejects(planSubjectMigration(gap, input), /does-not-cover/);
  const denied = manager({ info: async () => { throw Object.assign(new Error("permission denied"), { code: "403" }); }, add: () => assert.fail("must not write") });
  await assert.rejects(prepareSubjectMigration(denied, input), /permission denied/);
  for (const bad of [{}, { filter_subject: "msg.agent.>" }, { filter_subject: "msg.agent", filter_subjects: ["msg.agent"] }, { filter_subject: "msg.agent", deliver_subject: "push" }]) {
    const jsm = manager({ info: async () => ({ config: { ack_policy: AckPolicy.Explicit, ...bad } }) });
    await assert.rejects(prepareSubjectMigration(jsm, input), /incompatible/);
  }
});

test("rollback refuses both queued and delivered-but-unacked scoped traffic", async () => {
  for (const field of ["num_pending", "num_ack_pending"]) {
    const plan = await planSubjectMigration(manager(), input);
    const routes = new Map(plan.consumers.map((r) => [r.durableName, r]));
    const jsm = manager({ info: async (_stream, name) => ({ config: { ack_policy: AckPolicy.Explicit, filter_subject: routes.get(name).subject }, [field]: routes.get(name).channelId ? 1 : 0 }) });
    assert.equal((await checkSubjectRollback(jsm, input)).safeToDisableReceivers, false);
  }
});
