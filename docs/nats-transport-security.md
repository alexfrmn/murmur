# NATS transport security

Murmur permits plaintext NATS only on loopback. Every non-loopback client must
use a `tls://` URL; the shared connection builder then gives nats.js an explicit
TLS policy so the connection fails if TLS is unavailable or certificate and
hostname validation fail.

## Agent config

Use a distinct NATS user/password for every agent. Do not reuse the historical
shared token.

```json
{
  "natsUrl": "tls://broker.example:4222",
  "natsUser": "agent-a",
  "natsPassword": "A_DISTINCT_RANDOM_PASSWORD",
  "natsTls": {
    "caFile": "/run/secrets/murmur-nats-ca.pem"
  }
}
```

Omit `natsTls.caFile` only when the server certificate chains to a normal system
trust root. `certFile` and `keyFile` are available for deployments that also use
mutual TLS. If `natsUrl` contains a literal IP address, set
`natsTls.serverName` to the DNS identity in the certificate; Murmur rejects IP
endpoints without it because nats.js does not otherwise perform an IP hostname
check. The `serverName` field is optional for DNS URLs such as the example
above. Never put credentials in the URL.

## Shared client options contract

Every package that connects to NATS must pass the same
`SecureNatsClientConfig` shape to `buildSecureNatsConnectionOptions`:

```ts
{
  url,
  token,                  // token auth, or
  user, password,         // the complete user/password pair
  tls: {
    caFile,
    certFile, keyFile,    // the complete client-certificate pair
    serverName,
    handshakeFirst
  }
}
```

The profile mapping is mechanical: `natsUrl` becomes `url`, `natsToken` becomes
`token`, `natsUser`/`natsPassword` become `user`/`password`, and `natsTls`
becomes `tls`. Token and user/password authentication are mutually exclusive.
Callers must not rebuild this validation or pass raw `nats.js` TLS options.

Setup and packaging own filesystem validation: accept credentials and CA/client
certificate material through private-file inputs, resolve file paths to absolute
paths before writing the selected profile, and preserve the cert/key pairing.
Core owns transport validation: remote plaintext fails with
`nats-plaintext-non-loopback-rejected`; only exact loopback hosts may use
`nats://`; TLS certificate and hostname validation cannot be disabled. A remote
`tls://` token profile remains technically connectable for migration, but it
does not satisfy the per-peer credential cutover policy. The canonical setup CLI
accepts a token file or paired user/password files, plus a CA file and server
name. It does not expose client certificate/key inputs; deployments requiring
mutual TLS need that additional setup support before cutover.

## Server policy

TLS must be required; do not set `allow_non_tls`. A minimal two-peer core-NATS
configuration has symmetric, subject-bound permissions:

```hcl
host: "PRIVATE_OR_ALLOWLISTED_INTERFACE"
port: 4222
http: "127.0.0.1:8222"

tls {
  cert_file: "/run/secrets/server.crt"
  key_file: "/run/secrets/server.key"
  timeout: 2
}

authorization {
  users: [
    {
      user: "agent-a"
      password: "$2a$11$BCRYPT_HASH_FOR_AGENT_A"
      permissions: {
        publish: ["msg.agent-b", "ack.agent-b"]
        subscribe: ["msg.agent-a", "ack.agent-a"]
      }
    },
    {
      user: "agent-b"
      password: "$2a$11$BCRYPT_HASH_FOR_AGENT_B"
      permissions: {
        publish: ["msg.agent-a", "ack.agent-a"]
        subscribe: ["msg.agent-b", "ack.agent-b"]
      }
    }
  ]
}
```

Add only the proxy/presence/JetStream subjects actually used by that identity.
The example above is core NATS only. For JetStream use the runtime role below.
Store the config, server key, client config, and client password files as
owner-only (`0600`). Prefer a Tailscale/private listener. If a public listener is
unavoidable for a peer, firewall it to that peer's fixed address.

## Restricted JetStream runtime role

`buildNatsPeerPermissions({user, agentId, peerIds, stream?, consumers?,
jetstreamDomain?})` in `@murmurv2/core` renders the runtime publish/subscribe lists.
The default durable names are `<agentId>` and `<agentId>-ack`. Supply the explicit
channel durable names from a subject-migration plan when channel scoping is enabled.
The helper grants only the peer's own consumer INFO/NEXT APIs, stream INFO and its
JetStream ACK subjects, alongside its peer message/ACK subjects. Domain-aware ACK
subjects are included when `jetstreamDomain` is set. It grants no stream payload
GET, consumer creation/update/deletion, or stream management permissions.

An **operator identity** must create the shared `MURMUR` stream and every consumer
before runtime starts. Each consumer is a pull durable, explicit ACK, DeliverAll,
`ack_wait=30000000000` and `max_deliver=5` by default; its exact filter is
`msg.<agentId>`, `ack.<agentId>`, or the planned scoped channel subject. Match any
configured delivery limits. Runtime config then uses:

```json
"jetstream": {
  "enabled": true,
  "stream": "MURMUR",
  "provisioning": "client",
  "advisoryDlq": false
}
```

Client provisioning never creates/updates streams or consumers and refuses
consumer policy drift. Missing provisioning is an error, not a reason to grant
`$JS.API.>`. Consumer-creation APIs cannot safely be delegated just by durable
name: their payload can select another agent's filter. Management credentials
must remain outside runtime agent configs, including during scoped migrations.

Every username uses `_INBOX.<base64url(username)>` as its nats.js `inboxPrefix`.
Grant only that prefix with `.>` for replies; granting `_INBOX.>` would expose
other users' request replies. The connection builder chooses it automatically.
Raw clients must use the same builder or explicitly use `natsUserInboxPrefix(user)`.

Advisory-to-DLQ lookup reads raw stream messages by sequence. On a shared stream,
`STREAM.MSG.GET` exposes other peers' envelopes; the restricted runtime role does
not grant it. Set `advisoryDlq: false`; delivery ACK timeout/retry/DLQ remain active.
Run advisory correlation only under a separately trusted operator role or an
appropriately isolated account/stream. The Kubernetes example uses this restricted
runtime role and requires prior operator provisioning.

## Dashboard client

The dashboard accepts `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_CA_FILE`,
`NATS_CERT_FILE`, `NATS_KEY_FILE`, and `NATS_SERVER_NAME` through the same TLS
validator. It does not inherit daemon credentials. Give its separate NATS user
only subscription to the monitored `msg.>` scope and deny all publishes. Dashboard
HTTP authentication remains independently required. TLS options are allowlisted;
JSON config cannot override certificate checking with `rejectUnauthorized` or a
custom identity callback. IPv4 and IPv6 literal endpoints both require a DNS
certificate identity.

## Coordinated cutover

This procedure has **mesh-wide downtime** from stopping clients until the broker
and every required client pass validation. Book at least 30 minutes, including
rollback. Agree the start time, required-client list, operator, and decision maker
before starting. Keep an SSH/out-of-band coordination path independent of Murmur.
No broker restart or live client-config change is authorized by code review alone.

### Before the window: prepare and verify recovery material

Use one literal UTC window identifier, for example `20260919T150000Z`; that example
does not schedule a window. The paths below are a preparation contract, **not a
claim that backups already exist**. Record their verified absolute paths in the
window manifest before authorizing the switch. Backups contain secrets: directory
mode `0700`, files `0600`, original owners recorded, no Git upload or chat output.
Capture these backups from the currently running, verified topology for this
specific window. At the change freeze, compare live-file checksums to the manifest;
refresh and reverify any changed file before proceeding. Never select a historical
backup by glob, modification time or a "latest" directory: it may reference a
retired broker. Confirm every saved endpoint and old start command against the
working baseline before accepting it as rollback material.

- Broker host: use a verified persistent local filesystem. On CloudFarmSRV the
  designated backup directory is
  `/mnt/user/appdata/murmur-cutover/<window-id>/broker/`. Save `nats.conf.before`,
  every included config and referenced credential/certificate file under `files/`,
  and `manifest.json`. The manifest maps each backup to its canonical original
  absolute path, owner/mode, SHA-256, container mount destination, and image
  digest. Resolve the actual config bind mount from the running container; do not
  guess its host path. Record container start parameters, persistent JetStream
  volume, leaf configuration, and firewall rules; retain the current image locally.
- Each client host: use `/var/backups/murmur/<window-id>/clients/<client-id>/`
  (or an explicitly recorded persistent owner-private directory on hosts without
  `/var/backups`). Save `agent-config.json.before`, any service environment/CA files,
  and `manifest.json` mapping the canonical live paths and service/start commands.
  Inventory separate `DATA_DIR`s even when they share a code checkout. Include
  daemon, MCP/channel server, CLI, bridge, dashboard, remote peers and leaf clients;
  a list from one account or one host is not the complete mesh inventory.
- Save the **exact deployed old executable artifact** on every client host as
  `runtime-before.tar` in that client's backup directory, with a SHA-256 file.
  Include built packages/scripts, runtime dependencies and launch configuration,
  including any deployed changes absent from Git. Exclude live data directories
  and credentials from this archive; back them up separately above. Record its Git
  SHA, local changes and Node/binary version. Also retain that executable/Node
  version locally. For an image deployment, retain the old image by digest and a
  local image archive instead. Test extraction and loading the old artifact in an
  isolated directory with loopback NATS. Rollback must need neither Git fetch nor
  npm registry access; a source SHA or `package-lock.json` alone is insufficient.
- Stage each new config separately as `agent-config.json.tls`, validate its JSON,
  certificate/hostname, distinct credentials, own-consumer ACLs and connectivity
  against an isolated TLS broker. Preserve the old plaintext configuration until
  the announced switch. Check disk capacity and verify every backup checksum and
  owner can be restored. A missing/unreadable client config blocks readiness.
- Prepare operator provisioning for existing stream/legacy consumers plus new
  scoped consumers, without resetting their cursors. Check roster and migration
  plans for every affected receiver. Keep publisher `subjectScoping` off until
  TLS delivery works across the complete required-client list. Stage a second,
  tested TLS config with scoping disabled for a TLS-only rollback.

### Switch and acceptance timeline

1. At the announced start, confirm the decision maker is present and recovery
   material is verified. Quiesce producers and stop all inventoried clients,
   including auto-restarting services and short-lived MCP/CLI publishers. Record
   stream/consumer positions and pending counts. Do not purge messages or outboxes.
2. Stop the broker, preserve its persistent JetStream volume, install the staged
   TLS/user configuration and certificate files, validate with `nats-server -t -c`
   using the deployed image/binary, then start the broker. Use bcrypt password
   hashes in its config; never `allow_non_tls`. If validation fails, restore the
   saved files before starting it. Broker readiness is due by **T+2 minutes**.
3. Preprovision required consumers using the separate operator identity. Install
   the staged TLS configs and reviewed client artifact; start clients with
   `provisioning: "client"`, restricted ACLs and publisher scoping still off.
   By **T+5 minutes**, every required client must connect and pass an allowed
   durable message plus signed ACK in both directions. A running PID is not proof.
4. Validate foreign-consumer reads, raw stream reads, consumer creation and old
   token use are denied; verify dashboard read-only access, wrong-hostname and
   untrusted-CA rejection. Preserve baseline leaf connectivity and durable state.
   Only after TLS passes, enable prepared scoped receivers, then publishers in
   controlled pairs as described in [Phase N routing](phase-n-routing.md). Confirm
   both legacy and scoped delivery, no duplicate handler calls, and backlog drain.
5. By **T+10 minutes**, all required clients/routes and security checks must pass.
   Any missed T+2/T+5/T+10 gate means rollback starts immediately, not an open-ended
   debugging extension. Unauthorized access, cursor reset, lost messages or a
   duplicate side effect are immediate stop/rollback triggers at any point.
   Before accepting the change, enforce the agreed private/allowlisted listener
   policy and verify reachability from both an allowed and a denied external host.

### Rollback

- **One client config is broken while the TLS broker is healthy:** keep its
  publishers stopped, restore that client's prevalidated TLS-only config and
  compatible tested artifact, and restart only that client. Do not restore its
  plaintext config against a TLS-only broker or weaken broker verification. If it
  cannot pass the required proof before the current deadline, roll back the mesh.
- **Scoping fails after TLS passed:** disable scoped publishing on every sender
  first, including MCP/CLI processes and queued outbox retries. Keep the scoped
  receivers running until existing scoped outbox rows finish and the operator's
  `--check-rollback` reports no pending or ACK-pending messages for every affected
  receiver. Then disable scoped receiving and retain the consumers. An unsafe
  drain blocks disabling receivers; it does not authorize deleting backlog. Stop
  new writes and escalate recovery if the drain cannot complete within the window.
- **TLS/broker failure, or any required client misses its deadline:** stop all
  clients/producers and their restart supervisors. If scoped traffic has already
  been emitted, complete the safe drain above before removing compatible scoped
  receivers; otherwise keep recovery offline with state retained. Stop the broker,
  restore `nats.conf.before` and every mapped file with recorded owner/mode, restore
  its previous image/start parameters and network rules, validate the old config,
  then start it on the **same** JetStream volume. Never recreate the stream or
  restore an old stream snapshot over messages accepted during the window.
- Restore every client's `agent-config.json.before` and mapped service files.
  Extract its verified local `runtime-before.tar` into a separate rollback release
  directory and switch its recorded launcher to that release (or load/start the
  retained image digest). Restore the compatible Node executable if it changed.
  Keep each live `DATA_DIR`, SQLite DB/outbox and JetStream state in place; never
  overwrite them with the runtime archive. Restart the saved client commands only
  after the old broker is ready. **Restoring configs alone is insufficient:** the
  new TLS-enforcing code rejects the old non-loopback plaintext URL on startup.
- Confirm every required client reconnects, bidirectional signed delivery/ACK
  works, backlogs drain, consumer cursors were preserved and no duplicate handler
  effects occurred. Record failed gate, rollback start/end, proof and any retained
  backlog. Target completed recovery by **T+20 minutes**; if it fails, keep writers
  stopped, declare an incident through the independent channel and retain all
  state for recovery. Do not report success just because the container is running.

Run `packages/broker-nats/integration/run-secure-transport-live.sh` on a host
with `nats-server` and `openssl` for an isolated TLS/ACL proof.

This is a breaking cutover. Preparing and reviewing this branch does not authorize
a production restart or credential migration. Keep it out of the normal release
until the operator has an approved window and all clients/roles are ready.
