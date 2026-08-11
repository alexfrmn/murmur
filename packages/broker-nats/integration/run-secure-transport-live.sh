#!/usr/bin/env bash
set -euo pipefail

NATS_SERVER_BIN="${NATS_SERVER_BIN:-$(command -v nats-server || true)}"
OPENSSL_BIN="${OPENSSL_BIN:-$(command -v openssl || true)}"
SECURE_NATS_PORT="${SECURE_NATS_PORT:-14622}"

if [[ -z "$NATS_SERVER_BIN" || -z "$OPENSSL_BIN" ]]; then
  echo "SKIP: nats-server and openssl are required"
  exit 0
fi

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/murmur-secure-nats.XXXXXX")"
NATS_PID=""
cleanup() {
  if [[ -n "$NATS_PID" ]]; then
    kill "$NATS_PID" 2>/dev/null || true
    wait "$NATS_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

"$OPENSSL_BIN" req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost" \
  -keyout "$TEST_DIR/server.key" \
  -out "$TEST_DIR/server.crt" >/dev/null 2>&1
chmod 600 "$TEST_DIR/server.key"

cat >"$TEST_DIR/nats.conf" <<EOF
host: "127.0.0.1"
port: ${SECURE_NATS_PORT}
tls {
  cert_file: "${TEST_DIR}/server.crt"
  key_file: "${TEST_DIR}/server.key"
  timeout: 2
}
authorization {
  users: [
    {
      user: "agent-a"
      password: "test-password-a"
      permissions: {
        publish: ["msg.agent-b", "ack.agent-b"]
        subscribe: ["msg.agent-a", "ack.agent-a"]
      }
    },
    {
      user: "agent-b"
      password: "test-password-b"
      permissions: {
        publish: ["msg.agent-a", "ack.agent-a"]
        subscribe: ["msg.agent-b", "ack.agent-b"]
      }
    }
  ]
}
EOF

"$NATS_SERVER_BIN" -t -c "$TEST_DIR/nats.conf"
"$NATS_SERVER_BIN" -c "$TEST_DIR/nats.conf" >"$TEST_DIR/nats.log" 2>&1 &
NATS_PID=$!

TLS_READY=0
for _ in {1..30}; do
  kill -0 "$NATS_PID" 2>/dev/null || {
    sed -n '1,120p' "$TEST_DIR/nats.log" >&2
    exit 1
  }
  # Classic NATS TLS upgrades after the protocol INFO line, so a raw
  # openssl s_client readiness probe is not valid unless handshake_first is set.
  if grep -q "Server is ready" "$TEST_DIR/nats.log"; then
    TLS_READY=1
    break
  fi
  sleep 0.1
done
if [[ "$TLS_READY" != "1" ]]; then
  echo "TLS listener did not become ready" >&2
  sed -n '1,120p' "$TEST_DIR/nats.log" >&2
  exit 1
fi

SECURE_NATS_PORT="$SECURE_NATS_PORT" \
SECURE_NATS_CA_FILE="$TEST_DIR/server.crt" \
  node packages/broker-nats/integration/secure-transport.live.mjs
