import test from "node:test";
import assert from "node:assert/strict";
import { buildSecureNatsConnectionOptions } from "../dist/src/index.js";

test("requires TLS and preserves CA/client certificate files for remote NATS", () => {
  assert.deepEqual(
    buildSecureNatsConnectionOptions({
      url: "tls://broker.example:4222",
      user: "peer-a",
      password: "secret-a",
      tls: {
        caFile: "/run/secrets/nats-ca.pem",
        certFile: "/run/secrets/nats-client.pem",
        keyFile: "/run/secrets/nats-client.key",
      },
    }),
    {
      servers: "tls://broker.example:4222",
      user: "peer-a",
      pass: "secret-a",
      tls: {
        caFile: "/run/secrets/nats-ca.pem",
        certFile: "/run/secrets/nats-client.pem",
        keyFile: "/run/secrets/nats-client.key",
      },
    },
  );
});

test("tls URL requires certificate validation even without custom CA files", () => {
  assert.deepEqual(
    buildSecureNatsConnectionOptions({ url: "tls://broker.example:4222", token: "secret" }),
    { servers: "tls://broker.example:4222", token: "secret", tls: {} },
  );
});

test("literal IP TLS endpoints require an explicit DNS certificate identity", () => {
  assert.deepEqual(
    buildSecureNatsConnectionOptions({
      url: "tls://192.0.2.10:4222",
      tls: { caFile: "/run/secrets/nats-ca.pem", serverName: "murmur-broker.example" },
    }),
    {
      servers: "tls://192.0.2.10:4222",
      tls: { caFile: "/run/secrets/nats-ca.pem", servername: "murmur-broker.example" },
    },
  );
  assert.throws(
    () => buildSecureNatsConnectionOptions({ url: "tls://192.0.2.10:4222" }),
    /nats-tls-server-name-required-for-ip/,
  );
  assert.throws(
    () => buildSecureNatsConnectionOptions({
      url: "tls://192.0.2.10:4222",
      tls: { serverName: "192.0.2.10" },
    }),
    /nats-tls-server-name-invalid/,
  );
});

test("allows plaintext only on loopback", () => {
  for (const url of [
    "nats://127.0.0.1:4222",
    "nats://127.20.30.40:4222",
    "nats://localhost:4222",
    "nats://[::1]:4222",
  ]) {
    assert.deepEqual(buildSecureNatsConnectionOptions({ url }), { servers: url });
  }
  assert.throws(
    () => buildSecureNatsConnectionOptions({ url: "nats://broker.example:4222" }),
    /nats-plaintext-non-loopback-rejected/,
  );
  assert.throws(
    () => buildSecureNatsConnectionOptions({ url: "nats://127.attacker.example:4222" }),
    /nats-plaintext-non-loopback-rejected/,
  );
});

test("rejects ambiguous URLs and auth", () => {
  assert.throws(
    () => buildSecureNatsConnectionOptions({ url: "https://broker.example:4222" }),
    /nats-url-scheme-invalid/,
  );
  assert.throws(
    () => buildSecureNatsConnectionOptions({ url: "tls://user:pass@broker.example:4222" }),
    /nats-url-embedded-credentials-rejected/,
  );
  assert.throws(
    () => buildSecureNatsConnectionOptions({
      url: "tls://broker.example:4222",
      token: "token",
      user: "peer",
      password: "password",
    }),
    /nats-auth-methods-conflict/,
  );
  assert.throws(
    () => buildSecureNatsConnectionOptions({ url: "tls://broker.example:4222", user: "peer" }),
    /nats-user-password-pair-required/,
  );
});
