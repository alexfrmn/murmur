# Murmur V2 Kubernetes Reference

This directory is a minimal reference deployment for one Murmur V2 agent and a
private NATS broker. It is intentionally plain Kubernetes YAML, not a production
Helm chart.

## What It Creates

- `Namespace/murmur`
- `StatefulSet/murmur-nats` with JetStream storage
- `Service/murmur-nats` exposing NATS inside the cluster
- `Secret/murmur-nats-auth` with a per-agent user and bcrypt password hash
- `Secret/murmur-nats-tls` with the server certificate/key and client CA
- `StatefulSet/murmur-agent` with a per-agent SQLite PVC
- `Service/murmur-agent` exposing the optional Prometheus exporter in-cluster
- `Secret/murmur-agent-config` with an example `agent-config.json`

Presence/discovery metadata is public by design, but `agent-config.json` still
contains private keys and a NATS client password. Keep it in a secret manager or sealed
secret in real deployments.

## Build The Daemon Image

```bash
docker build -f deploy/Dockerfile.daemon -t ghcr.io/acme/murmur-v2-daemon:2.2.0 .
docker push ghcr.io/acme/murmur-v2-daemon:2.2.0
```

Update `deploy/kubernetes/agent-daemon.yaml` with your image name.

## Configure Secrets

Edit these placeholders before applying:

- `deploy/kubernetes/nats.yaml`: TLS PEM values, user, and bcrypt password hash
- `deploy/kubernetes/agent-config.example.yaml`: `agentId`, keys, peers, and the
  matching distinct plaintext client password

The example also exposes the streaming delivery knobs used by the daemon:

- `jetstream.maxDeliver` / `MURMUR_JETSTREAM_MAX_DELIVER`
- `jetstream.ackWaitMs` / `MURMUR_JETSTREAM_ACK_WAIT_MS`
- `streaming.ackTimeoutMs` / `MURMUR_ACK_TIMEOUT_MS`
- `streaming.ackWindow.maxInFlightChunks` /
  `MURMUR_STREAM_MAX_IN_FLIGHT_CHUNKS`
- `streaming.ackWindow.maxInFlightBytes` /
  `MURMUR_STREAM_MAX_IN_FLIGHT_BYTES`

For real clusters, prefer generating these from your secret manager:

```bash
kubectl -n murmur create secret generic murmur-nats-auth \
  --from-literal=NATS_USER="$NATS_USER" \
  --from-literal=NATS_PASSWORD_BCRYPT="$NATS_PASSWORD_BCRYPT" \
  --dry-run=client -o yaml

kubectl -n murmur create secret generic murmur-agent-config \
  --from-file=agent-config.json=/secure/path/agent-config.json \
  --dry-run=client -o yaml
```

## Deploy

```bash
kubectl apply -k deploy/kubernetes
kubectl -n murmur rollout status statefulset/murmur-nats
kubectl -n murmur rollout status statefulset/murmur-agent
```

The in-cluster NATS URL for agents is:

```text
tls://murmur-nats.murmur.svc.cluster.local:4222
```

For multiple agents, create one config secret and one agent StatefulSet per
agent, or keep this directory as a base and add per-agent Kustomize overlays.

## Notes

- SQLite outbox/message durability lives on the agent PVC at `/data/murmur.db`.
- JetStream is enabled for the broker and stores data at `/data/jetstream`.
- The agent StatefulSet runs `scripts/prometheus-exporter.mjs` as a sidecar on
  port `9464`; remove the sidecar and `murmur-agent` Service if you do not need
  metrics.
- This reference requires TLS and one subject-scoped user. Replace every
  placeholder before applying it; the example TLS secret is intentionally not a
  usable certificate. See `docs/nats-transport-security.md`.
- This reference does not expose NATS outside the cluster. Use an ingress,
  LoadBalancer, VPN, or NATS leaf-node topology only after setting explicit
  authz boundaries.
- Do not point this example at the shared production broker for smoke tests.
