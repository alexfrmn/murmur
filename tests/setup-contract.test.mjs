import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { statusVerdict, doctorChainValid } from "../packages/setup/dist/src/verdict.js";

const fixtures = new URL("../contracts/setup/v1/fixtures/", import.meta.url);
const now = Date.parse("2026-09-19T13:00:00Z");
function materialize(example) {
  const input = structuredClone(example);
  const offsets = { now: 0, "now-5m": -300000, "now+1h": 3600000 };
  if (Object.hasOwn(offsets, example.$stamp)) input.generatedAt = new Date(now + offsets[example.$stamp]).toISOString();
  else assert.equal(example.$stamp, "as-is", "unknown fixture stamp policy");
  return input;
}
function compare(file, example) {
  assert.ok(example.$expect?.code, `${file}: expected verdict is required`);
  const got = statusVerdict(materialize(example), now);
  assert.deepEqual(got, { ...example.$expect, missing: [...new Set(example.$expect.missing ?? [])].sort(), missingWhy: example.$expect.missingWhy ?? {} }, `${file}: verdict mismatch`);
}
const files = readdirSync(fixtures).filter(file => /^status-.*\.json$/.test(file));
assert.ok(files.length > 0, "canonical fixtures must be present");
for (const file of files) {
  const example = JSON.parse(readFileSync(new URL(file, fixtures), "utf8"));
  test(`shared contract: ${file}`, () => compare(file, example));
}
test("conformance gate rejects changed expectation and missing-field set", () => {
  const example = JSON.parse(readFileSync(new URL("status-green.json", fixtures), "utf8"));
  example.$expect.level = "red";
  assert.throws(() => compare("negative-control", example), /negative-control: verdict mismatch/);
  example.$expect.level = "green"; example.$expect.missing = ["invented-field"];
  assert.throws(() => compare("negative-control", example), /negative-control: verdict mismatch/);
});
for (const file of readdirSync(fixtures).filter(file => /^doctor-.*\.json$/.test(file))) {
  const example = JSON.parse(readFileSync(new URL(file, fixtures), "utf8"));
  test(`shared contract: ${file}`, () => {
    assert.equal(typeof example.$expect?.valid, "boolean", "doctor expectation is required");
    assert.equal(doctorChainValid(materialize(example)), example.$expect.valid, `${file}: chain validity mismatch`);
  });
}
test("conformance gate compares stable missing reasons and doctor stop reasons", () => {
  const example = JSON.parse(readFileSync(new URL("status-faultlog-unread.json", fixtures), "utf8"));
  example.$expect.missingWhy["outbox.faults"] = "invented-reason";
  assert.throws(() => compare("reason-negative-control", example), /reason-negative-control: verdict mismatch/);
  const doctor = JSON.parse(readFileSync(new URL("doctor-broker-fail.json", fixtures), "utf8"));
  doctor.stages.at(-1).reason = "blocked-by:config";
  assert.equal(doctorChainValid(doctor), false);
});
test("presence is distinct from null and additive extension keys stay allowed", () => {
  const input = materialize(JSON.parse(readFileSync(new URL("status-green.json", fixtures), "utf8")));
  input.futureExtension = { arbitrary: true };
  assert.equal(statusVerdict(input, now).code, "ok");
  input.inbox.unread = null;
  assert.equal(statusVerdict(input, now).code, "unmeasured");
  delete input.inbox.unread;
  assert.equal(statusVerdict(input, now).code, "schema.missing-key");
});
test("nullable broker state is unmeasured, not an observed connection failure", () => {
  const input = materialize(JSON.parse(readFileSync(new URL("status-green.json", fixtures), "utf8")));
  input.broker.state = null;
  assert.deepEqual(statusVerdict(input, now), { level: "grey", code: "unmeasured", unread: true, missing: ["broker.state"], missingWhy: {} });
});
