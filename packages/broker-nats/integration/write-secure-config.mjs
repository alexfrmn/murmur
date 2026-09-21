import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildNatsPeerPermissions, natsUserInboxPrefix } from "../../core/dist/src/index.js";

const [dir, port] = process.argv.slice(2);
const users = ["agent-a", "agent-b"].map((agentId) => ({
  user: agentId,
  password: `test-password-${agentId.at(-1)}`,
  permissions: buildNatsPeerPermissions({ user: agentId, agentId, peerIds: [agentId === "agent-a" ? "agent-b" : "agent-a"], jetstreamDomain: "test" }),
}));
users.push({ user: "bootstrap", password: "test-bootstrap", permissions: { publish: ["$JS.API.>"], subscribe: [`${natsUserInboxPrefix("bootstrap")}.>`] } });
users.push({ user: "dashboard", password: "test-dashboard", permissions: { publish: { deny: [">"] }, subscribe: ["msg.>"] } });
writeFileSync(join(dir, "nats.conf"), JSON.stringify({ host: "127.0.0.1", port: Number(port),
  jetstream: { store_dir: join(dir, "jetstream"), domain: "test" },
  tls: { cert_file: join(dir, "server.crt"), key_file: join(dir, "server.key"), timeout: 2 },
  authorization: { users },
}), { mode: 0o600 });
