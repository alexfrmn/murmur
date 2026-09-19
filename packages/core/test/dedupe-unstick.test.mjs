// Расшивка писем, застрявших в dedupe.
//
// Отметка «видел» ставится и доставленному письму, и отравленному — и дальше оба отвечают
// на повторную доставку `duplicate-ignored`. Для доставленного это правильно, для
// отравленного — ловушка: причину отказа снимает настройка (добавили пира, обновили ключ),
// а отметка остаётся, и письмо не доедет уже никогда. Отсюда два требования, которые
// сторожит этот файл: отправитель конверта сохраняется в строке, и сброс по отправителю
// трогает ТОЛЬКО отравленные.
//
// Повод: два конверта, лежащие в боевой базе с 31.08.2026 и штормящие NACK раз в две
// секунды одиннадцатый день. Для таких, записанных до 2.8.1, отправителя в строке нет —
// их снимает `clearPoisonedMsgIds` по явному списку.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { InMemoryDedupeStore, SQLiteDedupeOutboxStore } from "../dist/src/index.js";

const withTempDb = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), "murmur-dedupe-"));
  try {
    return await fn(path.join(dir, "murmur.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("add-peer снимает отметку с отравленных писем этого пира", async () => {
  await withTempDb(async (dbPath) => {
    const store = new SQLiteDedupeOutboxStore(dbPath);
    await store.markSeen("stuck-1", "agent-me", {
      senderAgentId: "agent-viola",
      poisonReason: "signature-invalid:agent-viola",
    });
    assert.equal(await store.seen("stuck-1", "agent-me"), true);

    assert.equal(await store.clearPoisonedFrom("agent-viola"), 1);
    assert.equal(await store.seen("stuck-1", "agent-me"), false);
  });
});

test("доставленные письма того же пира сброс не трогает — иначе приедет вся история", async () => {
  await withTempDb(async (dbPath) => {
    const store = new SQLiteDedupeOutboxStore(dbPath);
    await store.markSeen("delivered-1", "agent-me", { senderAgentId: "agent-viola" });
    await store.markSeen("stuck-1", "agent-me", {
      senderAgentId: "agent-viola",
      poisonReason: "handler-failed",
    });

    assert.equal(await store.clearPoisonedFrom("agent-viola"), 1);
    assert.equal(await store.seen("delivered-1", "agent-me"), true);
    assert.equal(await store.seen("stuck-1", "agent-me"), false);
  });
});

test("сброс по одному пиру не задевает письма другого", async () => {
  await withTempDb(async (dbPath) => {
    const store = new SQLiteDedupeOutboxStore(dbPath);
    await store.markSeen("theirs", "agent-me", {
      senderAgentId: "agent-kirill",
      poisonReason: "handler-failed",
    });

    assert.equal(await store.clearPoisonedFrom("agent-viola"), 0);
    assert.equal(await store.seen("theirs", "agent-me"), true);
  });
});

test("база, созданная до 2.8.1, получает колонки и не теряет строки", async () => {
  await withTempDb(async (dbPath) => {
    // Ровно та схема, что живёт в установках 2.8.0 и раньше.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE dedupe_seen (
        consumer_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (consumer_id, msg_id)
      );
    `);
    legacy
      .prepare("INSERT INTO dedupe_seen (consumer_id, msg_id, seen_at) VALUES (?, ?, ?)")
      .run("ws-povalyaev", "4daa1bf2-9407-4310-8176-0cc502fd9ada", "2026-08-31T22:38:00.000Z");
    legacy.close();

    const store = new SQLiteDedupeOutboxStore(dbPath);
    assert.equal(await store.seen("4daa1bf2-9407-4310-8176-0cc502fd9ada", "ws-povalyaev"), true);

    // Отправителя у такой строки нет — по пиру её не выбрать, только по msgId.
    assert.equal(await store.clearPoisonedFrom("agent-viola"), 0);
    assert.equal(await store.clearPoisonedMsgIds(["4daa1bf2-9407-4310-8176-0cc502fd9ada"]), 1);
    assert.equal(await store.seen("4daa1bf2-9407-4310-8176-0cc502fd9ada", "ws-povalyaev"), false);

    // И новая запись в мигрированную таблицу уже несёт происхождение.
    await store.markSeen("fresh", "ws-povalyaev", {
      senderAgentId: "agent-viola",
      poisonReason: "handler-failed",
    });
    assert.equal(await store.clearPoisonedFrom("agent-viola"), 1);
  });
});

test("миграция идемпотентна: второе открытие той же базы не падает", async () => {
  await withTempDb(async (dbPath) => {
    const first = new SQLiteDedupeOutboxStore(dbPath);
    await first.markSeen("m", "c", { senderAgentId: "s", poisonReason: "r" });
    const second = new SQLiteDedupeOutboxStore(dbPath);
    assert.equal(await second.seen("m", "c"), true);
  });
});

test("пустой список msgId ничего не удаляет", async () => {
  await withTempDb(async (dbPath) => {
    const store = new SQLiteDedupeOutboxStore(dbPath);
    await store.markSeen("keep", "c", { senderAgentId: "s", poisonReason: "r" });
    assert.equal(await store.clearPoisonedMsgIds([]), 0);
    assert.equal(await store.seen("keep", "c"), true);
  });
});

test("in-memory хранилище держит тот же контракт", async () => {
  const store = new InMemoryDedupeStore();
  await store.markSeen("delivered", "c", { senderAgentId: "agent-viola" });
  await store.markSeen("stuck", "c", { senderAgentId: "agent-viola", poisonReason: "handler-failed" });
  await store.markSeen("other", "c", { senderAgentId: "agent-kirill", poisonReason: "handler-failed" });

  assert.equal(await store.clearPoisonedFrom("agent-viola"), 1);
  assert.equal(await store.seen("stuck", "c"), false);
  assert.equal(await store.seen("delivered", "c"), true);
  assert.equal(await store.seen("other", "c"), true);
});

test("markSeen без метаданных остаётся рабочим вызовом", async () => {
  await withTempDb(async (dbPath) => {
    const store = new SQLiteDedupeOutboxStore(dbPath);
    await store.markSeen("bare", "c");
    assert.equal(await store.seen("bare", "c"), true);
    assert.equal(await store.clearPoisonedFrom("whoever"), 0);
  });
});
