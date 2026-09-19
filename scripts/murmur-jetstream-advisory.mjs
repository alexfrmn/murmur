export async function startJetStreamAdvisoryDlqIfEnabled({
  broker,
  outbox,
  jetstreamEnabled,
  advisoryDlqEnabled = true,
  log = () => {},
}) {
  if (!jetstreamEnabled || !advisoryDlqEnabled) return undefined;
  const subscription = await broker.startJetStreamAdvisoryDlq({ outbox });
  log("info", "JetStream advisory DLQ correlation started");
  return subscription;
}
