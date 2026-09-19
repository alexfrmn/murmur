import { AckPolicy, DeliverPolicy } from "nats";
import { channelSubjectRoutes, subjectMatchesFilter } from "@murmurv2/core";

const missing = (error) => error?.code === "404" || error?.api_error?.code === 404;

/** Read-only plan. Reuse one existing stream; never create overlapping streams. */
export async function planSubjectMigration(jsm, { stream, subject, consumerId, channelIds }) {
  const routes = channelSubjectRoutes(subject, consumerId, { enabled: true, channelIds });
  const info = await jsm.streams.info(stream);
  const filters = info.config.subjects ?? [];
  const consumers = [];
  for (const route of routes) {
    if (!filters.some((filter) => subjectMatchesFilter(route.subject, filter))) throw new Error(`subject-migration-stream-does-not-cover:${route.subject}`);
    let existing;
    try { existing = await jsm.consumers.info(stream, route.durableName); }
    catch (error) { if (!missing(error)) throw error; }
    if (existing && (existing.config.filter_subject !== route.subject || (existing.config.filter_subjects?.length ?? 0) > 0 || existing.config.ack_policy !== AckPolicy.Explicit || existing.config.deliver_subject)) {
      throw new Error(`subject-migration-consumer-incompatible:${route.durableName}`);
    }
    consumers.push({ ...route, exists: Boolean(existing), pending: existing?.num_pending ?? 0, ackPending: existing?.num_ack_pending ?? 0 });
  }
  return { stream, consumers, preservesLegacy: true, createsStream: false };
}

/** Idempotent additive prepare; leaves the legacy durable and every cursor intact. */
export async function prepareSubjectMigration(jsm, input) {
  const plan = await planSubjectMigration(jsm, input);
  for (const route of plan.consumers) {
    if (route.exists || route.channelId === undefined) continue;
    await jsm.consumers.add(plan.stream, {
      durable_name: route.durableName,
      name: route.durableName,
      filter_subject: route.subject,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      max_deliver: 5,
      ack_wait: 30_000_000_000,
    });
  }
  return planSubjectMigration(jsm, input);
}

/** Stop scoped publishers first; zero pending/ACK-pending is required before disabling receivers. */
export async function checkSubjectRollback(jsm, input) {
  const plan = await planSubjectMigration(jsm, input);
  const outstanding = plan.consumers.filter((r) => r.channelId !== undefined && (r.pending > 0 || r.ackPending > 0));
  return { ...plan, safeToDisableReceivers: outstanding.length === 0, outstanding };
}
