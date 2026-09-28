/**
 * Exit when the server link is gone (#276).
 *
 * A daemon whose broker connection has closed for good, or has been lost longer than the
 * operator allows, keeps its PID and its supervisor's "healthy" while delivering nothing.
 * This watch turns that into a non-zero exit so systemd, launchd or the Windows Service
 * manager restart the daemon and the failure becomes visible in their status.
 *
 * - `exitOnClosed` (default on): the connection reported `closed` — auth abort after a
 *   rotated token, reconnect attempts exhausted — and will never come back by itself.
 * - `maxDisconnectedMs` (default 0 = off): the link has been lost longer than this.
 */
export function createLinkWatch({ observation, maxDisconnectedMs = 0, exitOnClosed = true, intervalMs, log = () => {}, onLost, now = () => Date.now() }) {
  const limit = Number.isFinite(maxDisconnectedMs) && maxDisconnectedMs > 0 ? Math.floor(maxDisconnectedMs) : 0;
  const enabled = exitOnClosed || limit > 0;
  const period = intervalMs ?? (limit > 0 ? Math.max(1000, Math.min(30000, Math.floor(limit / 4))) : 5000);
  let timer;
  let fired = false;

  const fire = (reason, data) => {
    if (fired) return true;
    fired = true;
    log("fatal", "Server link is gone; exiting so the supervisor restarts the daemon", { reason, ...data });
    onLost?.(reason);
    return true;
  };

  const check = () => {
    if (fired) return true;
    if (!enabled) return false;
    const broker = observation.broker();
    if (exitOnClosed && broker.state === "closed") {
      return fire("broker.link-closed", { lastError: broker.lastError, disconnectedAt: broker.disconnectedAt });
    }
    if (limit > 0) {
      const disconnectedForMs = observation.disconnectedForMs(now());
      if (disconnectedForMs > limit) {
        return fire("broker.link-lost", { disconnectedAt: broker.disconnectedAt, disconnectedForMs, maxDisconnectedMs: limit,
          reconnectAttempts: broker.reconnectAttempts });
      }
    }
    return false;
  };

  return {
    enabled,
    maxDisconnectedMs: limit,
    intervalMs: period,
    start() {
      if (!enabled || timer) return;
      timer = setInterval(check, period);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    check,
  };
}
