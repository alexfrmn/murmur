#!/usr/bin/env node
import path from "node:path";
import { connect } from "nats";
import { buildNatsConnectionOptions } from "@murmurv2/broker-nats";
import { readPrivateJson } from "./secure-state.mjs";
import { planSubjectMigration, prepareSubjectMigration, checkSubjectRollback } from "./subject-migration.mjs";

const mode = process.argv[2] ?? "--plan";
if (!["--plan", "--prepare", "--check-rollback"].includes(mode) || process.argv.length > 3) {
  process.stderr.write("usage: DATA_DIR=<private dir> murmur-subject-migration.mjs [--plan|--prepare|--check-rollback]\n");
  process.exit(2);
}
const config = await readPrivateJson(path.join(process.env.DATA_DIR || ".data", "agent-config.json"));
if (config.subjectScoping?.enabled !== true) throw new Error("subject-scoping-config-required");
const nc = await connect(buildNatsConnectionOptions({ url: config.natsUrl, token: config.natsToken, waitOnFirstConnect: false, maxReconnectAttempts: 0 }));
try {
  const jsm = await nc.jetstreamManager();
  const input = { stream: config.jetstream?.stream || "MURMUR", subject: config.subject, consumerId: config.agentId, channelIds: config.subjectScoping.channelIds };
  const operation = mode === "--prepare" ? prepareSubjectMigration : mode === "--check-rollback" ? checkSubjectRollback : planSubjectMigration;
  const result = await operation(jsm, input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (mode === "--check-rollback" && !result.safeToDisableReceivers) process.exitCode = 1;
} finally { await nc.drain(); }
