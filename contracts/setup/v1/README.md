# Shared setup contract fixtures

Frozen consumer revision: `44b882d48f0139592dea9bd65d89b8a3f11c23cc`.

2.12 W1 deliberately extends the shared policy in TypeScript, Swift and Go:
`running-unmanaged` is a running Service, whose lifecycle is outside the selected
application service label. Four additive fixtures cover that state alone, with
terminal DLQ, with an effective pause, and without a Server. Their existing fault
priority is preserved. The `unread` verdict flag now means a delayed Assistant
delivery (`wake.delivery.pendingUndelivered > 0`), independently of the person's
inbox cursor. Existing fixture expectations for this flag are updated deliberately;
their color, missing-source and error-code expectations are unchanged.

2.11 policy extension: terminal DLQ records warn (`outbox.dead-letter`) while
active send failures still fail. Reversible local acknowledgements affect warning
attention only; an inconsistent/missing summary falls back to the actual DLQ count.
A backlog with both configured and observed wake paused warns
(`wake.paused-pending`); unapplied pause and recorded wake faults still fail.
Nine additive fixtures cover this extension across TypeScript, Swift and Go.
The required wire leaves below are preserved. A second deliberate 2.11 policy
change separates runtime readiness from peer proof: `paired=null` remains unknown
in the peer detail but does not make an otherwise ready service grey. A measured
`paired=false` still warns. The expectation in `status-pairing-unknown.json` is
intentionally updated to green/ok with no missing runtime field; the other original
fixtures are unchanged. Three additional fixtures cover two unchecked peers,
a measured mismatch and an invalid proof value across TS/Swift/Go.

All platforms read this directory directly. Do not keep private fixture copies or
expected verdict tables. Status files are JSON status responses with reserved test
metadata: `$expect` contains `level`, `unread`, `code`, and optional `missing` / `missingWhy`.
Compare missing entries as a set. Entries are dot-separated field paths only,
never localized explanations. Compare `missingWhy` as a path-to-stable-code map;
human-facing explanations are not conformance inputs. Missing required keys are distinct from explicit null;
unknown extension keys (including test metadata) remain allowed.

The runner injects a clock into the evaluator and materializes only the explicit
`$stamp` policy: `now`, `now-5m`, `now+1h`, or `as-is`. Reject unknown policies.
Never overwrite dates in `as-is` cases. Using one fixed UTC test clock makes
freshness, future time, and malformed timestamps reproducible.

`doctor-broker-fail.json` is a valid stopped chain; `doctor-bad-chain.json`
is invalid. Doctor files declare `$expect.valid`; runners must check that an earlier
failure makes every following stage skip with `blocked-by:<failed-stage>`.
Status schema failures carry separate codes for missing keys, wrong types and
invalid counter values. Changes to frozen expectations must be stated here and verified in every consumer.

Run the engine conformance suite after the TypeScript build:
`node --test tests/setup-contract.test.mjs`.
Both native builds must additionally run their own evaluator against these files.
An engine-only pass does not prove native conformance.

Packet-one required leaves (presence is checked before health evaluation):

| Type, or explicit null | Paths |
| --- | --- |
| string | `schema`, `generatedAt`, `service.state`, `broker.state`, `wake.faults.lastFault` |
| array | `peers.list` |
| number | `inbox.unread`, `outbox.queue.failed`, `outbox.queue.dlq`, `wake.delivery.pendingUndelivered` |
| boolean | `wake.config.enabled` |

A missing leaf (including a missing parent) yields `schema.missing-key`; a
non-null value of the wrong type yields `schema.wrong-type`. Negative counters
yield `schema.invalid-value`. No unread indicator is inferred from a response
that failed schema validation. Explicit null proceeds to the normal unknown
measurement policy; it does not mean zero. Unknown extension keys are ignored.

The checked counter set additionally includes `inbox.total`, queue
`pending`/`inflight`/`delivered`, and `service.restartsLastHour`. Values decoded
as counters must be nonnegative integers. The engine uses safe integers.

The conformance runner has negative controls: changing a color, the missing-field
set, a stable missing reason, or a blocked doctor's stage reason must fail.
