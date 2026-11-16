// Advisory DLQ correlation subscribes to broker-wide `$JS.EVENT.ADVISORY.*` subjects and
// reads the dead message back with STREAM.MSG.GET. A restricted runtime role
// (`jetstream.provisioning: "client"`, see docs/nats-transport-security.md) has neither
// permission by design, so for that role the feature is off unless the operator turns it
// on explicitly with `jetstream.advisoryDlq: true` after granting those subjects.
export function resolveAdvisoryDlqEnabled({ advisoryDlq, provisioning } = {}) {
  if (advisoryDlq === true) return { enabled: true, reason: "explicit" };
  if (advisoryDlq === false) return { enabled: false, reason: "explicit" };
  if (provisioning === "client") return { enabled: false, reason: "client-provisioning" };
  return { enabled: true, reason: "default" };
}

export async function startJetStreamAdvisoryDlqIfEnabled({
  broker,
  outbox,
  jetstreamEnabled,
  advisoryDlqEnabled,
  advisoryDlq,
  provisioning,
  log = () => {},
}) {
  if (!jetstreamEnabled) return undefined;
  const decision =
    advisoryDlqEnabled === undefined
      ? resolveAdvisoryDlqEnabled({ advisoryDlq, provisioning })
      : { enabled: Boolean(advisoryDlqEnabled), reason: "explicit" };
  if (!decision.enabled) {
    if (decision.reason === "client-provisioning") {
      log("info", "JetStream advisory DLQ correlation disabled for client provisioning", {
        hint: 'set jetstream.advisoryDlq: true after granting $JS.EVENT.ADVISORY.> and STREAM.MSG.GET to this role',
      });
    }
    return undefined;
  }
  const subscription = await broker.startJetStreamAdvisoryDlq({ outbox });
  log("info", "JetStream advisory DLQ correlation started");
  return subscription;
}
