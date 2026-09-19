# Shared setup contract fixtures

Frozen consumer revision: `44b882d48f0139592dea9bd65d89b8a3f11c23cc`.

All platforms read this directory directly. Do not keep private fixture copies or
expected verdict tables. Status files are JSON status responses with reserved test
metadata: `$expect` contains `level`, `unread`, `code`, and optional `missing`.
Compare missing entries as a set. Entries are dot-separated field paths only,
never localized explanations. Missing required keys are distinct from explicit null;
unknown extension keys (including test metadata) remain allowed.

The runner injects a clock into the evaluator and materializes only the explicit
`$stamp` policy: `now`, `now-5m`, `now+1h`, or `as-is`. Reject unknown policies.
Never overwrite dates in `as-is` cases. Using one fixed UTC test clock makes
freshness, future time, and malformed timestamps reproducible.

`doctor-broker-fail.json` is a valid stopped chain; `doctor-bad-chain.json`
is invalid. Doctor files declare `$expect.valid`; runners must check that an earlier
failure makes every following stage skip with `blocked-by:<failed-stage>`.
Status schema failures carry separate codes for missing keys, wrong types and
invalid counter values. This packet preserves the author's exact fixture bytes.

Run the engine conformance suite after the TypeScript build:
`node --test tests/setup-contract.test.mjs`.
Both native builds must additionally run their own evaluator against these files.
An engine-only pass does not prove native conformance.
