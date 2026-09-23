import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteDedupeOutboxStore, SQLiteMessageStore, stableEnvelopePayload } from '../packages/core/dist/src/index.js';
import { createKeyPair, createSigningKeyPair, decryptPayload, verifyEnvelopeSignature } from '../packages/security/dist/src/index.js';
import { classifyVerifiedDoctorMessage, createDoctorResponder, doctorReplyId } from '../scripts/doctor-protocol.mjs';

const at = Date.parse('2026-09-24T00:00:00Z');
const nonce = 'ab'.repeat(24);
const text = `Murmur diagnostic roundtrip. Reply in this same conversation with exactly this line: MURMUR-DOCTOR-REPLY ${nonce}`;
const request = (extra = {}) => ({msgId:randomUUID(), conversationId:`murmur:doctor:${randomUUID()}`,
  senderAgentId:'agent-a', recipients:['agent-b'], createdAt:new Date(at).toISOString(), ...extra});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-doctor-protocol-'));
  const file = path.join(root, 'murmur.db');
  const outbox = new SQLiteDedupeOutboxStore(file), messages = new SQLiteMessageStore(file);
  t.after(async () => { messages.close();outbox.close();await fs.rm(root,{recursive:true,force:true}); });
  const peerKeys = {encryption:await createKeyPair(),signing:await createSigningKeyPair()};
  const config = {agentId:'agent-b', keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},
    peers:{'agent-a':{subject:'msg.agent-a',encryption:{publicKey:peerKeys.encryption.publicKey},signing:{publicKey:peerKeys.signing.publicKey}}}};
  let clock = at;
  const makeResponder = (store = messages) => createDoctorResponder({config,outbox,messages:store,now:()=>clock});
  const read = (sql, ...args) => {const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}};
  return {config,peerKeys,outbox,messages,makeResponder,read,setClock:value=>{clock=value;}};
}

test('only the exact bounded diagnostic protocol is answered; ordinary messages stay ordinary', async t => {
  const f=await fixture(t), req=request();
  const classify=(envelope=req, body=text)=>classifyVerifiedDoctorMessage(f.config,envelope,body,at);
  assert.deepEqual(classify(),{kind:'request',nonce});
  assert.equal(classify({...req,conversationId:'dm:agent-a:agent-b'}),null);
  assert.deepEqual(classify(req,`MURMUR-DOCTOR-REPLY ${nonce}`),{kind:'reply'});
  const invalid = [
    [{...req,conversationId:'murmur:doctor:invalid'},text],
    [{...req,conversationId:req.conversationId+'\n'},text],
    [{...req,senderAgentId:'unknown'},text],
    [{...req,senderAgentId:'agent-b'},text],
    [{...req,recipients:['someone-else']},text],
    [{...req,recipients:['agent-b','someone-else']},text],
    [{...req,createdAt:new Date(at-60001).toISOString()},text],
    [{...req,createdAt:new Date(at+5001).toISOString()},text],
    [{...req,createdAt:'invalid'},text],
    [{...req,channelId:'other'},text],
    [{...req,senderMemberId:'other'},text],
    [{...req,addresseeMemberId:'other'},text],
    [req,text+'\n'], [req,text+' extra'], [req,'prefix '+text],
    [req,text.slice(0,-1)], [req,text.replace(nonce,nonce.toUpperCase())],
    [req,'MURMUR-DOCTOR-REPLY '+nonce+'\n'],
  ];
  for (const [envelope,body] of invalid) assert.deepEqual(classify(envelope,body),{kind:'ignored'});
  f.config.memberId='member-b';f.config.peers['agent-a'].memberId='member-a';f.config.peers['agent-a'].channelId='channel-one';
  assert.deepEqual(classify({...req,channelId:'channel-one',senderMemberId:'member-a',addresseeMemberId:'member-b'}),{kind:'request',nonce});
  assert.deepEqual(classify({...req,channelId:'channel-one',senderMemberId:'member-a'}),{kind:'ignored'});
});

test('reply is encrypted, signed, durable, routed to the peer, and never resurrects after ACK', async t => {
  const f=await fixture(t), req=request(), responder=f.makeResponder();
  f.config.memberId='member-b';Object.assign(f.config.peers['agent-a'],{memberId:'member-a',channelId:'channel-one'});
  Object.assign(req,{channelId:'channel-one',senderMemberId:'member-a',addresseeMemberId:'member-b'});
  const result=await responder.respond(req,text);
  assert.equal(result.state,'queued');
  const record=await f.outbox.getOutboxRecord(result.msgId), envelope=record.envelope;
  assert.deepEqual(envelope.recipients,['agent-a']);assert.equal(envelope.conversationId,req.conversationId);
  assert.equal(envelope.channelId,'channel-one');assert.equal(envelope.senderMemberId,'member-b');assert.equal(envelope.addresseeMemberId,'member-a');
  assert.equal(await verifyEnvelopeSignature(stableEnvelopePayload(envelope),envelope.signature,f.config.keys.signing.publicKey),true);
  const plain=await decryptPayload({ciphertext:envelope.payloadCiphertext,nonce:envelope.payloadNonce,senderPublicKey:f.config.keys.encryption.publicKey},f.peerKeys.encryption.privateKey);
  assert.equal(plain,`MURMUR-DOCTOR-REPLY ${nonce}`);
  assert.equal(f.read('SELECT text FROM local_messages WHERE msg_id=?',result.msgId)[0].text,plain);
  await f.outbox.markAcked(result.msgId);
  const retries=await Promise.all(Array.from({length:10},()=>f.makeResponder().respond(req,text)));
  assert.ok(retries.every(x=>x.state==='already-queued'&&x.msgId===result.msgId));
  assert.equal((await f.outbox.getOutboxRecord(result.msgId)).status,'acked');
  assert.equal(f.read('SELECT * FROM outbox').length,1);assert.equal(f.read('SELECT * FROM local_messages').length,1);
  await assert.rejects(f.makeResponder().respond(req,text.replace(nonce,'cd'.repeat(24))),/doctor.request-conflict/);
});

test('redelivery completes history after a crash between outbox enqueue and local append', async t => {
  const f=await fixture(t), req=request();
  const failing=f.makeResponder({append:async()=>{throw new Error('simulated crash');}});
  await assert.rejects(failing.respond(req,text),/simulated crash/);
  assert.equal(f.read('SELECT * FROM outbox').length,1);assert.equal(f.read('SELECT * FROM local_messages').length,0);
  assert.equal((await f.makeResponder().respond(req,text)).state,'already-queued');
  assert.equal(f.read('SELECT * FROM local_messages').length,1);
  assert.equal((await f.makeResponder().respond(request(),`MURMUR-DOCTOR-REPLY ${nonce}`)).state,'ignored');
  assert.equal(f.read('SELECT * FROM outbox').length,1);
  assert.notEqual(doctorReplyId('other-agent',req),doctorReplyId(f.config.agentId,req));
});

test('per-peer and global response limits bound new work without blocking idempotent retries', async t => {
  const f=await fixture(t), responder=f.makeResponder(), first=request();
  await responder.respond(first,text);
  for(let i=1;i<6;i++) assert.equal((await responder.respond(request(),text)).state,'queued');
  assert.equal((await responder.respond(request(),text)).state,'rate-limited');
  assert.equal((await responder.respond(first,text)).state,'already-queued');
  for(let peer=1;peer<=9;peer++) {
    f.config.peers[`peer-${peer}`]=f.config.peers['agent-a'];
    for(let i=0;i<6;i++) assert.equal((await responder.respond(request({senderAgentId:`peer-${peer}`}),text)).state,'queued');
  }
  f.config.peers['peer-extra']=f.config.peers['agent-a'];
  assert.equal((await responder.respond(request({senderAgentId:'peer-extra'}),text)).state,'rate-limited');
  assert.equal(f.read('SELECT count(*) n FROM outbox')[0].n,60);
  f.setClock(at+60001);
  assert.equal((await responder.respond(request({createdAt:new Date(at+60001).toISOString()}),text)).state,'queued');
});
