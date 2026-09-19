// Отказы, которые чинит настройка, а не переотправка.
//
// Регрессия, которую сторожит этот файл (найдена agent-kirill 2026-09-11): письмо от ещё
// не добавленного пира падало с `unknown-sender:<id>`, брокер считал это отравленным
// письмом и после трёх попыток писал msgId в `dedupe_seen`. Дальше замыкался круг —
// отправитель ретраит, получатель отбивает `duplicate-ignored`, подтверждение не уходит
// никогда, и конверт не доезжает ДАЖЕ ПОСЛЕ add-peer. За ночь это дало 3898 повторных
// доставок одного msgId, 12243 переотправки и 1008 реконнектов к брокеру.
//
// Правило простое: отказ восстановим тогда, когда его снимает действие человека
// (добавить пира), а не повтор доставки. Такой конверт остаётся retryable — предел
// доставок ставит JetStream, и письмо оседает в DLQ, откуда его видно.
//
// Невалидная подпись при ИЗВЕСТНОМ пире восстановимой не считается намеренно: это либо
// рассинхрон ключей, либо попытка писать от чужого имени, и повторять доставку незачем.
import test from "node:test";
import assert from "node:assert/strict";

import { isRecoverableRejection, RECOVERABLE_REJECTION_PREFIXES } from "../dist/src/index.js";

test("unknown-sender восстановим: его снимает add-peer, а не повтор доставки", () => {
  assert.equal(isRecoverableRejection("unknown-sender:agent-sasha"), true);
  assert.equal(isRecoverableRejection("unknown-sender:agent-kirill"), true);
});

test("отказы, которые повтор доставки не чинит, восстановимыми не считаются", () => {
  assert.equal(isRecoverableRejection("signature-invalid:agent-sasha"), false);
  assert.equal(isRecoverableRejection("invalid-envelope"), false);
  assert.equal(isRecoverableRejection("handler-failed"), false);
  assert.equal(isRecoverableRejection("auth-rejected:denied"), false);
  assert.equal(isRecoverableRejection(""), false);
});

test("совпадение только по префиксу — подстрока в середине причины не считается", () => {
  assert.equal(isRecoverableRejection("handler-failed: unknown-sender:agent-x"), false);
});

test("список префиксов непустой и все они проверяются как префиксы", () => {
  assert.ok(RECOVERABLE_REJECTION_PREFIXES.length > 0);
  for (const prefix of RECOVERABLE_REJECTION_PREFIXES) {
    assert.equal(isRecoverableRejection(`${prefix}whatever`), true);
    assert.equal(isRecoverableRejection(`x${prefix}whatever`), false);
  }
});
