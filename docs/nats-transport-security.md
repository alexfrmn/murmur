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
JetStream management and advisory subjects are intentionally absent from the
core-NATS example; enabling JetStream requires a separately reviewed permission
set. Store the config, server key, client config, and client password files as
owner-only (`0600`). Prefer a Tailscale/private listener. If a public listener is
unavoidable for a peer, firewall it to that peer's fixed address.

## Coordinated cutover

1. Inventory every client and its exact publish/subscribe subjects.
2. Generate the server certificate and separate client passwords. Store bcrypt
   password hashes—not plaintext client passwords—in `nats.conf`.
3. Deliver each peer only its own password and the public CA/certificate through
   an authenticated, encrypted channel.
4. Update all clients to `tls://`, username/password, and the correct CA file.
5. Stop the clients, replace the broker config, validate it with
   `nats-server -t -c`, restart the broker, then restart clients.
6. Prove allowed delivery works, forbidden subjects raise permission violations,
   the old token fails, and wrong CA/hostname connections fail.
7. Block arbitrary public TCP/4222 and confirm from an external host.

Run `packages/broker-nats/integration/run-secure-transport-live.sh` on a host
with `nats-server` and `openssl` for an isolated TLS/ACL proof.
