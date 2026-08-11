import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, StringCodec } from "nats";
import { buildSecureNatsConnectionOptions } from "../../core/dist/src/index.js";

const port = process.env.SECURE_NATS_PORT;
const caFile = process.env.SECURE_NATS_CA_FILE;
assert.ok(port && caFile, "secure NATS test environment is incomplete");

const url = `tls://127.0.0.1:${port}`;
const connectPeer = (user, password) => connect(buildSecureNatsConnectionOptions({
  url,
  user,
  password,
  tls: { caFile, serverName: "localhost" },
}));

const peerA = await connectPeer("agent-a", "test-password-a");
const peerB = await connectPeer("agent-b", "test-password-b");
const codec = StringCodec();

try {
  const allowed = peerB.subscribe("msg.agent-b", { max: 1 });
  await peerB.flush();
  peerA.publish("msg.agent-b", codec.encode("allowed"));
  await peerA.flush();
  const received = await Promise.race([
    (async () => {
      for await (const message of allowed) return codec.decode(message.data);
      return undefined;
    })(),
    sleep(2_000).then(() => "timeout"),
  ]);
  assert.equal(received, "allowed", "allowed per-peer message was not delivered");

  const deniedStatus = (async () => {
    for await (const event of peerA.status()) {
      if (event.type === "error" && String(event.data).includes("PERMISSIONS_VIOLATION")) {
        return event;
      }
    }
    return undefined;
  })();
  peerA.publish("msg.agent-a", codec.encode("denied"));
  await peerA.flush().catch(() => undefined);
  assert.ok(
    await Promise.race([deniedStatus, sleep(2_000).then(() => undefined)]),
    "forbidden publish did not produce a permission violation",
  );

  await assert.rejects(
    connect(buildSecureNatsConnectionOptions({
      url,
      token: "retired-shared-token",
      tls: { caFile, serverName: "localhost" },
    })),
    /authorization|authentication/i,
  );

  await assert.rejects(
    connect(buildSecureNatsConnectionOptions({
      url,
      user: "agent-a",
      password: "test-password-a",
      tls: { caFile, serverName: "wrong-host.example" },
    })),
    /certificate|hostname|IP/i,
  );

  console.log("secure NATS transport/ACL integration passed");
} finally {
  await Promise.allSettled([peerA.drain(), peerB.drain()]);
}
