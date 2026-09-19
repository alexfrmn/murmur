import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../scripts/secure-state.mjs";

const mode = (filePath) => statSync(filePath).mode & 0o777;

test("private JSON writes use a 0700 directory and atomic 0600 file", async () => {
  const root = mkdtempSync(join(tmpdir(), "murmur-private-state-"));
  const dir = join(root, ".data");
  const config = join(dir, "agent-config.json");

  try {
    await writePrivateJson(config, { generation: 1, secret: "first" });
    const firstInode = statSync(config).ino;
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(config), 0o600);
    assert.deepEqual(await readPrivateJson(config), { generation: 1, secret: "first" });

    await writePrivateJson(config, { generation: 2, secret: "second" });
    assert.notEqual(statSync(config).ino, firstInode);
    assert.equal(mode(config), 0o600);
    assert.deepEqual(await readPrivateJson(config), { generation: 2, secret: "second" });
    assert.deepEqual(readdirSync(dir), ["agent-config.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private JSON reads repair permissive modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "murmur-private-mode-"));
  const dir = join(root, ".data");
  const config = join(dir, "agent-config.json");

  try {
    await writePrivateJson(config, { secret: true });
    chmodSync(dir, 0o775);
    chmodSync(config, 0o664);

    assert.deepEqual(await readPrivateJson(config), { secret: true });
    assert.equal(mode(dir), 0o775, "read does not unexpectedly rewrite an arbitrary parent mode");
    assert.equal(mode(config), 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private JSON writes reject a symlink target without changing its destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "murmur-private-symlink-"));
  const dir = join(root, ".data");
  const destination = join(root, "outside.json");
  const config = join(dir, "agent-config.json");

  try {
    await writePrivateJson(join(dir, "seed.json"), { seed: true });
    writeFileSync(destination, "outside", { mode: 0o600 });
    symlinkSync(destination, config);

    await assert.rejects(
      writePrivateJson(config, { secret: "must-not-write" }),
      /private-state-file-invalid/,
    );
    assert.equal(readFileSync(destination, "utf8"), "outside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
