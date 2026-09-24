// One pass of the daemon delivery loop. Outbound letters and notifications keep flowing
// while an assistant works: a wake turn can last many minutes, and awaiting it here held
// every reply in the outbox until the turn ended or timed out (24.09, the Mac sat on a
// ping from 11:29 to 11:36). WakeMonitor.drain() is single-flight, so starting it on
// every tick only kicks the running dispatcher; its rows stay durable across restarts.
export async function flushTick({ flushOutbox, flushNotify, drainWake, log }) {
  try {
    await flushOutbox();
  } catch (err) {
    log("error", "Outbox flush error", { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    await flushNotify();
  } catch (err) {
    log("error", "Notify flush error", { error: err instanceof Error ? err.message : String(err) });
  }

  // #105 — retry tick. With no drain running this reads the table: deliveries whose
  // backoff has elapsed and rows a previous process left behind. A running drain is
  // only nudged; such rows wait until it frees its conversations.
  Promise.resolve()
    .then(drainWake)
    .catch((err) => log("error", "Wake retry drain error", { error: err instanceof Error ? err.message : String(err) }));
}
