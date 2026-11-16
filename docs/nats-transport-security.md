---
title: Optional NATS TLS and broker migration
status: release-candidate
date: 2026-10-16
tags: [murmur, transport, operations]
---

# Optional NATS TLS and broker migration

The 2.12.1 candidate adds explicit TLS, per-user broker credentials and a guarded
configuration migration. Existing `nats://` profiles, including remote token-auth
profiles, keep working. Installing this version does not change the broker,
rotate credentials or enable a mandatory TLS policy.

> [!IMPORTANT]
> End-to-end message encryption and TLS protect different boundaries. TLS also
> protects broker credentials and the network connection. A remote `nats://`
> profile remains compatible; compatibility is not evidence of TLS protection.

## Connection policy

| Configuration | Behavior |
| --- | --- |
| Existing `nats://host:4222` | Preserved, without forcing a transport migration. |
| `tls://host:4222` | Requires TLS and a trusted server certificate matching the selected DNS name. No plaintext fallback. |
| `tls://127.0.0.1:4222` | Also requires an explicit `natsTls.serverName` containing the certificate's DNS name. |
| Token plus user/password, or incomplete user/password | Rejected before connecting. |
| Credentials in the URL, unsupported TLS options or verification overrides | Rejected. |

`@murmurv2/core` exports `buildNatsTransportOptions` for the compatible policy.
The separately named `buildSecureNatsConnectionOptions` opts into rejecting remote
plaintext; ordinary runtime entry points do not enable that stricter policy.
Both require certificate validation for explicit TLS endpoints.

Supported profile fields are `natsUrl`, `natsToken`, or the pair `natsUser` /
`natsPassword`, and optional `natsTls` with `caFile`, `certFile`, `keyFile`,
`serverName` and `handshakeFirst`. Client certificate and key must be paired.
The default CA trust store is used when `caFile` is absent. `serverName` chooses
the DNS identity to verify; it is not a verification bypass.

Daemon, MCP reply tap, channel server, doctor, A2A/OpenClaw bridges, subject
migration and agent runner pass these fields to the shared connection builder.
Broker credentials and TLS configuration are pinned for each running daemon/MCP
instance: contact reload cannot silently switch them. Restart the affected
processes explicitly after an authorized transport change.

## Create or join a TLS identity

The broker operator supplies a URL, credentials and, for private PKI, a CA file.
Use absolute paths to existing regular files. Credential files must be owned by
the user, private (POSIX owner-only permissions or a verified Windows private ACL),
single-line and nonempty. Symlinks are rejected. Files are size-limited. CA files
are also checked for ownership, type and size. Keep all supplied files available
to the service account at their original paths.

```sh
murmur init --agent-id MY-AGENT --broker-url tls://broker.example:4222 --user-file /private/broker-user --password-file /private/broker-password --ca-file /private/broker-ca.pem --data-dir /absolute/profile
```

Publicly trusted certificates need no `--ca-file`. A literal IP URL needs
`--server-name broker.example`. Token authentication uses `--token-file` instead
of the user/password pair. The CLI does not accept raw secrets as arguments.

The same credential/TLS options are accepted by `join`. An Invitation retains the
existing wire format: token-bearing invitations still contain that token and
report `containsBrokerCredential: true`. User/password and private CA settings
are not embedded in invitations; the recipient supplies their own files:

```sh
murmur join --agent-id COLLEAGUE --invite-file /private/invite.txt --user-file /private/my-broker-user --password-file /private/my-broker-password --ca-file /private/broker-ca.pem --reply-out /private/reply.txt --data-dir /absolute/colleague-profile
```

An invitation containing a token cannot be combined with different credentials.
Repeating `init` or `join` does not rotate an existing profile's credentials.
The desktop pairing screens do not collect separate TLS credential files in this
candidate; use the CLI for these optional settings. Client-certificate settings
are available through the profile/library configuration, not new CLI flags.

## Migrate an existing broker configuration

Preview only:

```sh
murmur broker migrate --broker-url tls://broker.example:4222 --user-file /private/broker-user --password-file /private/broker-password --ca-file /private/broker-ca.pem --data-dir /absolute/profile --json
```

The result has schema `murmur.broker-migration/1`; `from` and `to` expose only
scheme and authentication kind. Preview does not write files, stop a service or
contact the proposed broker. It does not prove the new server is reachable.
Migration replaces the transport credentials: supply the intended target token
or user/password files explicitly. Omitting both selects no broker authentication.

For a changed configuration, `--apply` additionally requires the selected
service to report **stopped**, no observed live daemon, and an independent native
probe reporting no observed use. Close client integrations holding its files,
stop the owned service explicitly, and repeat the complete command with `--apply`.
An unknown service state or unknown usage is refused. An adapter may report an
uninstalled service as stopped; the independent file-usage check is still required.
There is no force flag.

Linux examines profile paths in process descriptors and macOS uses `lsof`; limited process visibility,
concurrent changes, aliases, hardlinks or unsupported tree entries produce unknown
or refusal. Windows uses the matching service helper and Restart Manager to check
holders of the selected SQLite store, together with the selected service state;
it does not enumerate every unrelated file under the profile directory. These
checks can refuse on a normal unprivileged machine even after its visible clients
close. Do not erase observation files or recreate the identity to evade refusal.
See [migration diagnostics](setup-onboarding.md#migrating-an-existing-broker).

Before replacement the writer checks configuration bytes and all supplied input
contents again, repeats the usage check, and creates a private byte-exact backup.
It keeps identity, contacts, database and wake cursor unchanged. A write failure
attempts verified atomic rollback; `migration.config-write-uncertain` requires
inspection of the preserved backup and configuration before further changes.
The command never automatically stops or starts a service. After a successful
apply, start the owned service and restart its client integrations, then require
`doctor --peer ID` and a reply from the intended assistant. Migration success
alone proves neither delivery nor assistant wake.

## Restricted JetStream and dashboard roles

`buildNatsPeerPermissions` generates peer-specific publish/subscribe and reply-inbox
ACLs, including scoped JetStream consumer info, pull and acknowledgement subjects.
It does not grant stream-message reads or consumer creation. Optional domains are
supported. Operators must provision the stream and each expected durable first,
including a separate ACK durable. Set `jetstreamProvisioning: "client"` for these
runtime credentials; absent or incompatible durables fail without administrative
creation/update. With `jetstream.provisioning: "client"` the daemon does not start
advisory DLQ correlation: it needs broker-wide `$JS.EVENT.ADVISORY.>` subscriptions
and `STREAM.MSG.GET`, which this role does not have. Grant both and set
`jetstream.advisoryDlq: true` to enable it. `jetstream.advisoryDlq: false` disables it
for any role. The default provisioning behavior is unchanged.

The dashboard independently accepts `NATS_URL`, `NATS_TOKEN` or `NATS_USER` /
`NATS_PASSWORD`, and `NATS_CA_FILE`, `NATS_CERT_FILE`, `NATS_KEY_FILE`,
`NATS_SERVER_NAME`. Give it its own read-only broker role; do not inherit a daemon
write role. The isolated integration below contains a runnable synthetic broker
configuration with peer, bootstrap and dashboard roles. Existing deployment and
Kubernetes defaults are not migrated by this change.

## Reproducible checks and scope

From a built checkout with `nats-server` and `openssl` on PATH:

```sh
node --test tests/setup-tls-config.test.mjs tests/setup-broker-migration.test.mjs tests/setup-profile-usage.test.mjs tests/setup-state-backup.test.mjs tests/setup-onboarding-live.test.mjs
MURMUR_REQUIRE_TLS_BROKER=1 bash packages/broker-nats/integration/run-secure-transport-live.sh
```

The live tests create disposable loopback brokers and certificates. They exercise
both legacy and TLS CLI/daemon signed encrypted exchanges, observe the MCP reply
tap connection, reject TLS-to-plaintext downgrade, wrong hostname, untrusted CA
and retired credentials, and check restricted JetStream/dashboard permissions.
Migration tests inject service/usage evidence and verify unchanged state on
refusal, byte-exact backup and rollback. Those fixtures do not certify native
migration success on a user's Mac or Windows installation. macOS CI requires the
TLS ACL integration dependencies rather than treating their absence as a pass.

This implements the compatible client/authentication/migration portion of #153.
Mandatory remote TLS, deployment certificates, shared-broker credential rotation
and coordinated peer cutover are separate operational changes. No production TLS
or credential revocation is claimed here. The [NKey enrollment reference](participant-enrollment.md)
remains a design/reference implementation; these static user/password credentials
do not implement automatic per-device enrollment or individual runtime revocation.
