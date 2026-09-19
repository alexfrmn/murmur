#!/usr/bin/env node
// One-shot publish-prep for the @murmurv2/* workspace packages: makes each package
// publishable to the public npm registry without changing its name. Idempotent.
//   - preserve `private: true` packages byte-for-byte (publication is opt-in)
//   - set license: "MIT" + repository (with directory) + publishConfig.access=public
//   - add a short `description` (npm hygiene; stubs marked experimental)
//   - rewrite intra-workspace `@murmurv2/*` deps (file:../x or pinned) to `^<version>`
//   - `prepack: npm run build` guard so a publish/pack can never ship an empty dist
//   - files: ["dist/src", "LICENSE"] (+ "schema" when present) — ships compiled JS+d.ts,
//     drops dist/tsconfig.tsbuildinfo noise
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "git+https://github.com/alexfrmn/murmur.git";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgsDir = path.join(root, "packages");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/prep-publish.mjs [--check]");
const check = args.includes("--check");

const DESCRIPTIONS = {
  "@murmurv2/core": "Murmur V2 core — EnvelopeV1/AckV1 wire types, SQLite outbox + dedupe stores, machine-readable protocol schema.",
  "@murmurv2/security": "Murmur V2 crypto — X25519 + XChaCha20-Poly1305 + Ed25519 envelope encrypt/sign/verify (MLS scaffold).",
  "@murmurv2/broker-nats": "Murmur V2 NATS broker — core pub/sub with optional JetStream durability (finite redelivery + DLQ).",
  "@murmurv2/broker-ws": "Murmur V2 WebSocket broker adapter — local relay and browser/edge-friendly transport semantics.",
  "@murmurv2/mcp-server": "Murmur V2 MCP server — 7 tools for agent-to-agent messaging over the Model Context Protocol.",
  "@murmurv2/federation": "Murmur V2 federation — org/agent addressing, Ed25519 signed roster + RosterStore, roster-backed auth tokens.",
  "@murmurv2/federation-nats": "Murmur V2 federation NATS contract — fed.* subjects + account-config renderer for cross-org leaf-node meshes.",
  "@murmurv2/bridge-a2a": "Murmur V2 to A2A protocol bridge (alpha) — terminates @a2a-js/sdk and re-wraps tasks as E2E Murmur envelopes.",
  "@murmurv2/bridge-telegram": "Murmur V2 Telegram notification adapter.",
  "@murmurv2/bridge-murmur": "Murmur V2 Murmur-to-Murmur bridge (experimental placeholder/stub).",
  "@murmurv2/bridge-openclaw": "Murmur V2 OpenClaw bridge (legacy/experimental).",
  "@murmurv2/observability": "Murmur V2 observability helpers (scaffold).",
};

// Read and validate the entire graph before changing any manifest. A typo in a
// later dependency must not leave earlier packages partially prepared.
const packages = [];
const byName = new Map();
for (const dir of readdirSync(pkgsDir).sort()) {
  const file = path.join(pkgsDir, dir, "package.json");
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  const original = readFileSync(file, "utf8"), pkg = JSON.parse(original);
  if (!pkg.name) continue;
  if (byName.has(pkg.name)) throw new Error(`Duplicate workspace package: ${pkg.name}`);
  byName.set(pkg.name, pkg);
  packages.push({ dir, file, original, pkg });
}
const changes = [];
for (const { dir, file, original, pkg } of packages) {
  if (pkg.private === true) continue;
  if (typeof pkg.version !== "string" || !pkg.version) throw new Error(`Missing version: ${pkg.name}`);

  pkg.license = "MIT";
  pkg.repository = { type: "git", url: REPO_URL, directory: `packages/${dir}` };
  pkg.publishConfig = { access: "public" };
  if (!pkg.description && DESCRIPTIONS[pkg.name]) pkg.description = DESCRIPTIONS[pkg.name];

  const version = pkg.version;
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[key];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith("@murmurv2/")) continue;
      const dependency = byName.get(name);
      if (!dependency) throw new Error(`${pkg.name}: unknown workspace dependency ${name}`);
      if (dependency.private === true) throw new Error(`${pkg.name}: private workspace dependency ${name} is not publishable`);
      if (typeof dependency.version !== "string" || !dependency.version) throw new Error(`Missing version: ${name}`);
      deps[name] = `^${dependency.version}`;
    }
  }

  // build guard: npm pack/publish always rebuilds dist first → never ship an empty tarball
  pkg.scripts = { ...(pkg.scripts || {}), prepack: "npm run build" };

  // ship only the compiled output + LICENSE (+ schema where present); excludes tsbuildinfo
  const files = ["dist/src", "LICENSE"];
  if (existsSync(path.join(pkgsDir, dir, "schema"))) files.splice(1, 0, "schema");
  pkg.files = files;

  const content = JSON.stringify(pkg, null, 2) + "\n";
  if (content !== original) changes.push({ file, content, label: `${pkg.name}@${version}` });
}
for (const { file, content, label } of changes) {
  if (!check) writeFileSync(file, content);
  console.log(`${check ? "needs preparation" : "prepped"} ${label}`);
}
if (check && changes.length) process.exitCode = 1;
