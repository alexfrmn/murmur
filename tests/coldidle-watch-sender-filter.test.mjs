import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "murmur-coldidle-watch.sh");
const haveTools = process.platform !== "win32"
  && spawnSync("sqlite3", ["-version"]).status === 0
  && spawnSync("flock", ["--version"]).status === 0;

const fixture = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "murmur-watch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "murmur.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE local_messages (id TEXT, direction TEXT NOT NULL, sender TEXT, text TEXT, created_at TEXT)");
  const insert = db.prepare("INSERT INTO local_messages (id, direction, sender, text, created_at) VALUES (?, ?, ?, ?, ?)");
  let n = 0;
  const add = (direction, sender, text) => insert.run(`m${++n}`, direction, sender, text, new Date().toISOString());
  add("inbound", "agent-codex-volt", "older letter, before the watcher started");
  const run = (env) => {
    const child = spawn("bash", [SCRIPT], { env: { ...process.env, MURMUR_DB: dbPath, MURMUR_WATCH_INTERVAL: "1",
      MURMUR_WAKE_CURSOR: path.join(dir, "cursor"), MURMUR_WATCH_LOCK: path.join(dir, "lock"), MURMUR_WATCH_LOCK_WAIT: "2", ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    const settled = (ms) => Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("running"), ms))]);
    return { child, exited, settled, out: () => stdout, err: () => stderr };
  };
  return { dir, db, add, run };
};

test("letters from an ignored sender do not wake; the next wanted letter does", { skip: !haveTools && "needs sqlite3 and flock" }, async (t) => {
  const f = await fixture(t);
  const w = f.run({ MURMUR_WATCH_IGNORE_SENDERS: "agent-codex-volt, aim-codex" });
  t.after(() => { if (w.child.exitCode === null) w.child.kill(); });
  assert.equal(await w.settled(1500), "running", "seeded to tip: the older letter never wakes");
  assert.match(w.out(), /фильтр отправителей —.*sender NOT IN \('agent-codex-volt','aim-codex'\)/);

  f.add("inbound", "agent-codex-volt", "[CODEX->JARVIS] sync");
  f.add("inbound", "aim-codex", "FULL BUILD done");
  f.add("outbound", "agent-jarvis", "our own letter");
  assert.equal(await w.settled(2500), "running", "ignored letters and our outbound never wake");

  f.add("inbound", "agent-danik", "вопрос Дана про онтологию");
  assert.equal(await w.exited, 0);
  assert.match(w.out(), /MURMUR COLD-IDLE WAKE: 1 new inbound message\(s\)/);
  assert.match(w.out(), /\[agent-danik\] вопрос Дана/);
  assert.doesNotMatch(w.out(), /CODEX->JARVIS/);
  assert.equal((await fs.readFile(path.join(f.dir, "cursor"), "utf8")).trim(), "5", "cursor advanced to the wanted letter");
});

test("an only-list wakes for its senders alone", { skip: !haveTools && "needs sqlite3 and flock" }, async (t) => {
  const f = await fixture(t);
  const w = f.run({ MURMUR_WATCH_ONLY_SENDERS: "agent-danik" });
  t.after(() => { if (w.child.exitCode === null) w.child.kill(); });
  assert.equal(await w.settled(1500), "running");
  f.add("inbound", "agent-misha", "ключ для env");
  assert.equal(await w.settled(2500), "running", "a letter from someone else stays silent");
  f.add("inbound", "agent-danik", "ответ");
  assert.equal(await w.exited, 0);
  assert.match(w.out(), /1 new inbound message/);
});

test("a malformed id is dropped from the filter instead of reaching SQL", { skip: !haveTools && "needs sqlite3 and flock" }, async (t) => {
  const f = await fixture(t);
  const w = f.run({ MURMUR_WATCH_IGNORE_SENDERS: "agent-codex-volt,x') OR 1=1 --,agent-b" });
  t.after(() => { if (w.child.exitCode === null) w.child.kill(); });
  assert.equal(await w.settled(1500), "running");
  assert.match(w.err(), /некорректный agentId в фильтре отброшен: x'\)OR1=1--/);
  assert.match(w.out(), /sender NOT IN \('agent-codex-volt','agent-b'\)/);
  f.add("inbound", "agent-danik", "hi");
  assert.equal(await w.exited, 0);
});

test("without a filter every inbound letter wakes, as before", { skip: !haveTools && "needs sqlite3 and flock" }, async (t) => {
  const f = await fixture(t);
  const w = f.run({});
  t.after(() => { if (w.child.exitCode === null) w.child.kill(); });
  assert.equal(await w.settled(1500), "running");
  assert.doesNotMatch(w.out(), /фильтр отправителей/);
  f.add("inbound", "agent-codex-volt", "sync");
  assert.equal(await w.exited, 0);
  assert.match(w.out(), /1 new inbound message/);
});
