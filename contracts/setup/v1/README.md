# Shared setup contract fixtures

Frozen consumer revision: `78b40c4605f421a2d6bc8435846066fa953ff51c`.

All platforms read this directory directly. Do not keep private fixture copies or
expected verdict tables. Status files are JSON status responses with reserved test
metadata: `$expect` contains `level`, `unread`, `code`, and optional `missing`.
Compare missing entries as a set. In this frozen revision those entries include
localized explanations; do not silently rename them in just one implementation.

The runner injects a clock into the evaluator and materializes only the explicit
`$stamp` policy: `now`, `now-5m`, `now+1h`, or `as-is`. Reject unknown policies.
Never overwrite dates in `as-is` cases. Using one fixed UTC test clock makes
freshness, future time, and malformed timestamps reproducible.

`doctor-broker-fail.json` is retained verbatim for review provenance. It is a
**negative example**, not a valid doctor response: wake is warn after broker fail,
where the contract requires skip/blocked-by:broker. Its date is also in 2099.
A valid doctor example requires a reviewed contract update.

Run the engine conformance suite after the TypeScript build:
`node --test tests/setup-contract.test.mjs`.
Both native builds must additionally run their own evaluator against these files.
An engine-only pass does not prove native conformance.
