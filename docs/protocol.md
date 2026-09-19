
### ACK verification diagnostics

A signed frame whose sender key is unavailable is rejected with
`signature-key-unavailable`. A missing verifier is separately reported as
`signature-verifier-unavailable`. Neither means a cryptographic verification
failed: `signature-invalid` is reserved for an attempted check that did not
verify. Unsigned/malformed frames remain `unsigned-or-malformed`. Every rejection
leaves the outbox and replay nonce unchanged; after the correct public key is
installed, the same signed frame can be verified normally within its time window.
Only the literal successful verification result `true` can settle a record.

Observers and status consumers must distinguish signed-and-verified,
signed-but-unverifiable, and unsigned. An explicitly invalid signature is a
verification failure, not a missing-key condition. Invalid-ACK reason counters
are diagnostics, not a count of delivered messages or authenticated identities.
