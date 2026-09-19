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

1. Inventory every client and its exact publish/subscribe subjects.
2. Generate the server certificate and separate client passwords. Store bcrypt
   password hashes—not plaintext client passwords—in `nats.conf`.
3. Deliver each peer only its own password and the public CA/certificate through
   an authenticated, encrypted channel.
4. Update all clients to `tls://`, username/password, and the correct CA file.
5. Stop the clients, replace the broker config, validate it with
   `nats-server -t -c`, restart the broker, then restart clients.
6. Prove allowed durable delivery plus signed ACK works, foreign consumer reads,
   stream payload reads and consumer creation are denied, the dashboard reads but
   cannot publish, the old token fails, and untrusted CA/wrong hostname fail.
7. Block arbitrary public TCP/4222 and confirm from an external host.

Run `packages/broker-nats/integration/run-secure-transport-live.sh` on a host
with `nats-server` and `openssl` for an isolated TLS/ACL proof.

This is a breaking cutover. Preparing and reviewing this branch does not authorize
a production restart or credential migration. Keep it out of the normal release
until the operator has an approved window and all clients/roles are ready.
