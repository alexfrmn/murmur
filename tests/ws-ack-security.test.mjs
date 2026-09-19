import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketBroker } from '../packages/broker-ws/dist/src/index.js';
import { JsonFileOutboxStore, InMemoryAckReceiptStore, createAck, createBoundAck, stableAckPayload } from '../packages/core/dist/src/index.js';
import { createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from '../packages/security/dist/src/index.js';
const envelope = { schemaVersion:'1.0', msgId:'ws-security', conversationId:'c', senderAgentId:'alice', recipients:['bob'], createdAt:new Date().toISOString(), payloadCiphertext:'cipher', payloadNonce:'nonce', signature:'sig' };
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'murmur-ws-security-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const outbox = new JsonFileOutboxStore(join(dir,'outbox.json'));
  await outbox.enqueue('msg.bob',envelope); await outbox.markSent(envelope.msgId);
  const keys = await createSigningKeyPair(), unsigned = createBoundAck(envelope,'bob','ack');
  const ack = { ...unsigned, signature:await signEnvelope(stableAckPayload(unsigned),keys.privateKey) };
  const broker = new WebSocketBroker({ url:'ws://example.invalid' }), events=[];
  const options = { outbox, ackReceipts:new InMemoryAckReceiptStore(), onInvalidAck:e=>events.push(e.reason), verifyAck:a=>verifyEnvelopeSignature(stableAckPayload(a),a.signature,keys.publicKey) };
  return {outbox,ack,broker,events,options, process:a=>broker.processAckFrame(a,options,'ack.alice')};
}
for (const required of [undefined,false,true]) test(`WS unsigned ACK/NACK never changes outbox, legacy option ${required}`,async t=>{
  const f=await fixture(t); f.options.requireSignedAcks=required;
  const before=await f.outbox.getOutboxRecord(envelope.msgId);
  for(const status of ['ack','nack']) await f.process(createAck(envelope.msgId,'bob',status,'forged'));
  assert.deepEqual(await f.outbox.getOutboxRecord(envelope.msgId),before);
  assert.deepEqual(f.events,['unsigned-or-malformed','unsigned-or-malformed']);
});
test('WS missing key does not consume nonce; same signed frame succeeds once key is available',async t=>{
  const f=await fixture(t), verify=f.options.verifyAck;
  f.options.verifyAck=async()=> 'key-unavailable'; await f.process(f.ack);
  assert.equal((await f.outbox.getOutboxRecord(envelope.msgId)).status,'sent');
  assert.deepEqual(f.events,['signature-key-unavailable']);
  f.options.verifyAck=verify; await f.process(f.ack);
  assert.equal((await f.outbox.getOutboxRecord(envelope.msgId)).status,'acked');
});
for(const [value,reason] of [[undefined,'signature-verifier-unavailable'],[false,'signature-invalid'],['unexpected','signature-verifier-result-invalid']]) test(`WS verifier ${String(value)} fails closed with distinct reason`,async t=>{
  const f=await fixture(t); f.options.verifyAck=value===undefined?undefined:async()=>value;
  await f.process(f.ack); assert.equal((await f.outbox.getOutboxRecord(envelope.msgId)).status,'sent'); assert.deepEqual(f.events,[reason]);
});
for(const offset of [-3600_000,3600_000]) test(`WS rejects ACK timestamp outside accepted window (${offset})`,async t=>{
  const f=await fixture(t); f.options.verifyAck=async()=>true;
  await f.process({...f.ack,at:new Date(Date.now()+offset).toISOString()});
  assert.equal((await f.outbox.getOutboxRecord(envelope.msgId)).status,'sent');
  assert.deepEqual(f.events,['timestamp-out-of-window']);
});
test('WS default receipt cache rejects replayed NACK after retry',async t=>{
  const f=await fixture(t); delete f.options.ackReceipts; f.options.verifyAck=async()=>true;
  const ack={...f.ack,status:'nack',reason:'retry'};
  await f.process(ack); await f.outbox.markSent(envelope.msgId); await f.process(ack);
  assert.equal((await f.outbox.getOutboxRecord(envelope.msgId)).status,'sent');
  assert.deepEqual(f.events,['nonce-replay']);
});
test('WS ACK publisher failure after commit cannot turn delivery into a NACK',async t=>{
  const f=await fixture(t), published=[];
  f.broker.publishAck=async(_subject,ack)=>{published.push(ack.status);if(ack.status==='ack')throw new Error('disconnected');};
  const dedupe={seen:async()=>false,markSeen:async()=>{}};
  await f.broker.processEnvelopeFrame(envelope,{consumerId:'bob',dedupe,onMessage:async()=>{},signAck:async ack=>({...ack,signature:'signed'})});
  assert.deepEqual(published,['ack']);
});
