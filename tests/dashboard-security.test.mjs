import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stableEnvelopePayload } from "../packages/core/dist/src/index.js";
import {
  createKeyPair,
  createSigningKeyPair,
  encryptPayload,
  signEnvelope,
} from "../packages/security/dist/src/index.js";
import { SECURITY_HEADERS, isAuthorizedHeader, loadDashboardToken } from "../dashboard/http-security.mjs";
import { authenticateEnvelope } from "../dashboard/message-security.mjs";
import { createAgentItem, createMessageElement } from "../dashboard/render.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class FakeClassList {
  constructor(node) { this.node = node; }
  add(...names) {
    const values = new Set(this.node.className.split(/\s+/).filter(Boolean));
    for (const name of names) values.add(name);
    this.node.className = [...values].join(" ");
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
  }
  append(...children) { this.children.push(...children); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
}

const fakeDocument = { createElement: (tag) => new FakeElement(tag) };
const findClass = (node, name) => {
  if (node.className.split(/\s+/).includes(name)) return node;
  for (const child of node.children) {
    const found = findClass(child, name);
    if (found) return found;
  }
  return undefined;
};

test("dashboard sources have no HTML parser or inline script/event-handler sinks", async () => {
  const html = await readFile(path.join(repoRoot, "dashboard", "dashboard.html"), "utf8");
  const js = await readFile(path.join(repoRoot, "dashboard", "dashboard.js"), "utf8");
  const render = await readFile(path.join(repoRoot, "dashboard", "render.mjs"), "utf8");
  const combined = `${html}\n${js}\n${render}`;

  assert.doesNotMatch(combined, /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<script(?![^>]+\bsrc=)[^>]*>/i);
  assert.match(html, /<script type="module" src="\/dashboard\.js"><\/script>/);
});

test("CSP forbids inline script, handlers, objects, framing, and external defaults", () => {
  const csp = SECURITY_HEADERS["Content-Security-Policy"];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("renderer assigns hostile message text as literal textContent", () => {
  const payload = `"><img src=x onerror="globalThis.pwned=1"><script>pwned()</script>`;
  const node = createMessageElement(fakeDocument, {
    type: "message",
    from: `bad' onclick='pwned()`,
    to: `</span><script>pwned()</script>`,
    text: payload,
    authenticated: true,
    encrypted: true,
    direction: "inbound",
  });

  assert.equal(findClass(node, "msg-text").textContent, payload);
  assert.equal(findClass(node, "from").textContent, "unknown");
  assert.equal(findClass(node, "to").textContent, "unknown");
  assert.equal(node.children.length, 2);
});

test("agent renderer rejects invalid identifiers and attaches a real listener", () => {
  assert.throws(() => createAgentItem(fakeDocument, {
    agent: `x' onclick='pwned()`,
    onToggle: () => {},
  }), /invalid agent id/);

  let toggled;
  const node = createAgentItem(fakeDocument, {
    agent: "agent-safe",
    isSelf: true,
    isOnline: true,
    isActive: false,
    onToggle: (agent) => { toggled = agent; },
  });
  node.listeners.get("click")();
  assert.equal(toggled, "agent-safe");
  assert.equal(findClass(node, "agent-name").textContent, "agent-safe (me)");
});

test("dashboard token loader enforces private mode and Basic auth", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "murmur-dashboard-auth-"));
  const tokenFile = path.join(dir, "token");
  const token = "dashboard_token_0123456789_ABCDEFGHIJ";
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  assert.equal(loadDashboardToken(tokenFile), token);
  const header = `Basic ${Buffer.from(`murmur:${token}`).toString("base64")}`;
  assert.equal(isAuthorizedHeader(header, token), true);
  assert.equal(isAuthorizedHeader(header, `${token}x`), false);
  assert.equal(isAuthorizedHeader(undefined, token), false);

  await chmod(tokenFile, 0o644);
  assert.throws(() => loadDashboardToken(tokenFile), /group or others/);
});

async function fixture() {
  const localEncryption = await createKeyPair();
  const peerEncryption = await createKeyPair();
  const localSigning = await createSigningKeyPair();
  const peerSigning = await createSigningKeyPair();
  const encrypted = await encryptPayload("literal <script>not code</script>", localEncryption.publicKey, peerEncryption.privateKey);
  const envelope = {
    schemaVersion: "1.0",
    msgId: "msg-1",
    conversationId: "agent-peer:agent-local",
    senderAgentId: "agent-peer",
    recipients: ["agent-local"],
    createdAt: "2026-08-11T12:00:00.000Z",
    payloadCiphertext: encrypted.ciphertext,
    payloadNonce: encrypted.nonce,
    signature: "",
  };
  envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), peerSigning.privateKey);
  return {
    envelope,
    config: {
      agentId: "agent-local",
      keys: { encryption: localEncryption, signing: localSigning },
      peers: { "agent-peer": { encryption: peerEncryption, signing: peerSigning } },
    },
  };
}

test("only signed, recipient-bound, local envelopes become authenticated events", async () => {
  const { envelope, config } = await fixture();
  const accepted = await authenticateEnvelope(JSON.stringify(envelope), "msg.agent-local", config);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.event.authenticated, true);
  assert.equal(accepted.event.text, "literal <script>not code</script>");

  const unsigned = await authenticateEnvelope(JSON.stringify({ from: "agent-peer", payload: "hello" }), "msg.agent-local", config);
  assert.deepEqual(unsigned, { accepted: false, reason: "unsigned-or-invalid-envelope" });

  const tampered = { ...envelope, msgId: "tampered" };
  assert.equal((await authenticateEnvelope(JSON.stringify(tampered), "msg.agent-local", config)).accepted, false);
  assert.deepEqual(
    await authenticateEnvelope(JSON.stringify(envelope), "msg.someone-else", config),
    { accepted: false, reason: "recipient-subject-mismatch" },
  );
});
