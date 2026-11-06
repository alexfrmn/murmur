import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexAppServerInjector, NO_REPLY_REQUIRED } from '../scripts/codex-app-server-wake.mjs';
import { normalizeWakeConfig } from '../scripts/wake-monitor.mjs';
import { persistOwnerReview, readOwnerReview } from '../scripts/owner-review-store.mjs';

const payload = { from:'peer-demo', conversationId:'work-demo', msgId:'12345678-1234-4234-8234-123456789012' };
function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'murmur-owner-review-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const storePath=path.join(dataDir,'murmur.db'), db=new DatabaseSync(storePath);
  db.exec('CREATE TABLE local_messages(msg_id TEXT,direction TEXT,sender TEXT,conversation_id TEXT,created_at TEXT)');
  db.prepare('INSERT INTO local_messages VALUES(?,?,?,?,?)').run(payload.msgId,'inbound',payload.from,payload.conversationId,'2026-01-01T00:00:00Z');
  db.close();
  return {dataDir,storePath,socketPath:'/tmp/test-owner.sock',threadId:'demo-thread',ownerReviewOnly:true,relayFinalToMurmur:true};
}
test('owner review opt-in survives normalization',()=>{
  assert.equal(normalizeWakeConfig({wake:{peers:{demo:{ownerReviewOnly:true}}}}).peers.demo.ownerReviewOnly,true);
});
test('owner sink binds to a stored inbound and preserves the first draft',t=>{
  const peer=fixture(t); assert.equal(readOwnerReview(peer,payload),null);
  const first=persistOwnerReview(peer,payload,'first draft');
  assert.deepEqual(persistOwnerReview(peer,payload,'second draft'),first);
  assert.equal(fs.statSync(path.join(peer.dataDir,`owner-inbox-${payload.msgId}.json`)).mode&0o777,0o600);
  assert.throws(()=>persistOwnerReview(peer,{...payload,from:'other-peer'},'bad'),/source-invalid/);
  assert.throws(()=>persistOwnerReview(peer,{...payload,conversationId:'other'},'bad'),/source-invalid/);
  assert.throws(()=>persistOwnerReview(peer,{...payload,msgId:'../outside'},'bad'),/source-invalid/);
});
test('unknown or symlink inbox records fail closed',t=>{
  const peer=fixture(t), file=path.join(peer.dataDir,`owner-inbox-${payload.msgId}.json`);
  fs.writeFileSync(file,'{}',{mode:0o600}); assert.throws(()=>readOwnerReview(peer,payload),/source-invalid/);
  fs.unlinkSync(file); fs.symlinkSync(peer.storePath,file); assert.throws(()=>readOwnerReview(peer,payload));
});
test('completed owner review cannot relay and retry cannot start a second turn',async t=>{
  const peer=fixture(t); let starts=0;
  class Client { async request(){return {};} async startTurnAndWaitForFinal(){starts++;return {status:'completed',turnId:'demo-turn',finalText:'draft for owner'};} }
  const inject=createCodexAppServerInjector({Client,relay:async()=>assert.fail('must never send'),relayAlreadyQueued:async()=>assert.fail('must not inspect relay')});
  const first=await inject(payload,peer),second=await inject(payload,peer);
  assert.equal(first.outcome,'owner_review_required');assert.equal(first.replyMsgId,null);assert.equal(first.finalText,null);
  assert.equal(second.source,'owner-review-idempotent');assert.equal(starts,1);
  assert.equal(readOwnerReview(peer,payload).peer_send_authorized,false);
});
test('ACK completes without draft; failed/empty turns cannot become owner decisions',async t=>{
  const peer=fixture(t);let result={status:'completed',finalText:NO_REPLY_REQUIRED};
  class Client {async request(){return {};}async startTurnAndWaitForFinal(){return result;}}
  const inject=createCodexAppServerInjector({Client,relay:async()=>assert.fail('must never send')});
  assert.equal((await inject(payload,peer)).outcome,'no_reply_required');assert.equal(readOwnerReview(peer,payload),null);
  result={status:'failed',finalText:'partial'};await assert.rejects(inject(payload,peer),/turn-failed/);
  result={status:'completed',finalText:''};await assert.rejects(inject(payload,peer),/final-empty/);
  assert.equal(readOwnerReview(peer,payload),null);
});
