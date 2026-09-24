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

  // #105 — retry tick: deliveries whose backoff has elapsed, and anything a previous
  // process left behind, are picked up from the table here.
  Promise.resolve()
    .then(drainWake)
    .catch((err) => log("error", "Wake retry drain error", { error: err instanceof Error ? err.message : String(err) }));
}
