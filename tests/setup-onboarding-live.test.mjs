import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { connect, StringCodec } from 'nats';
import { stableEnvelopePayload } from '../packages/core/dist/src/index.js';
import { signEnvelope } from '../packages/security/dist/src/index.js';
import { probeRoundtrip } from '../packages/setup/dist/src/doctor.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { platformAdapter } from '../packages/setup/dist/src/cli.js';
import { runDoctor } from '../packages/setup/dist/src/doctor.js';
const exec=promisify(execFile), root=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) { const end=Date.now()+12000; while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await delay(50);}throw new Error('onboarding-live.timeout'); }
async function stop(child) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  const done=new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM');
  const timeout=setTimeout(()=>child.kill('SIGKILL'),3000); try{await done;}finally{clearTimeout(timeout);}
}
test('CLI invite handshake proves daemon roundtrip without an AI responder or wake', { timeout:30000 }, async t=>{
  try{execFileSync('nats-server',['--version'],{stdio:'ignore'});}catch{t.skip('isolated nats-server unavailable');return;}
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'murmur-onboard-live-'))), children=[];
  let nc; t.after(async()=>{if(nc)await nc.close();for(const child of children.reverse())await stop(child);await fs.rm(base,{recursive:true,force:true});});
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const url=`nats://127.0.0.1:${port}`;
  children.push(spawn('nats-server',['-a','127.0.0.1','-p',String(port)],{stdio:'ignore'}));
  nc=await until(async()=>connect({servers:url,reconnect:false,timeout:100}));
  const env=id=>({PATH:process.env.PATH,HOME:base,DATA_DIR:path.join(base,id)});
  const cli=async(id,...args)=>JSON.parse((await exec(process.execPath,['packages/setup/bin/murmur.mjs',...args,'--data-dir',path.join(base,id),'--json'],{cwd:root,env:env(id)})).stdout);
  await cli('agent-a','init','--agent-id','agent-a','--broker-url',url);
  const publicUrl=`nats://server.example.com:${port}`;
  await cli('agent-a','invite','--broker',publicUrl,'--out',path.join(base,'invite'));
  assert.equal((await cli('agent-b','join','--agent-id','agent-b','--invite-file',path.join(base,'invite'),'--reply-out',path.join(base,'reply'))).paired,null);
  await cli('agent-a','add-peer','--reply-file',path.join(base,'reply'));
  // The Invitation carries a public name. Route only this disposable recipient
  // back to the isolated broker; this test performs no DNS or Internet access.
  const recipientPath=path.join(base,'agent-b','agent-config.json');
  const recipient=JSON.parse(await fs.readFile(recipientPath,'utf8'));
  assert.equal(recipient.natsUrl,publicUrl);
  await fs.writeFile(recipientPath,JSON.stringify({...recipient,natsUrl:url}));
  for(const id of ['agent-a','agent-b']) children.push(spawn(process.execPath,['scripts/murmur-daemon.mjs'],{cwd:root,env:env(id),stdio:'ignore'}));
  const read=(id,sql,...params)=>{const db=new DatabaseSync(path.join(base,id,'murmur.db'),{readOnly:true});try{return db.prepare(sql).get(...params);}finally{db.close();}};
  for(const id of ['agent-a','agent-b']) await until(async()=>{
    const observation=JSON.parse(await fs.readFile(path.join(base,id,'daemon-observation.json'),'utf8'));
    return observation.broker?.state==='connected';
  });
  const context=resolveContext({dataDir:path.join(base,'agent-a'),repoRoot:root});
  const config=JSON.parse(await fs.readFile(context.configPath,'utf8'));
  const pending=probeRoundtrip(context,config,'agent-b',nc,10000); pending.catch(()=>{});
  const challenge=await until(()=>read('agent-b',"SELECT text,conversation_id FROM local_messages WHERE direction='inbound' AND conversation_id LIKE 'murmur:doctor:%' ORDER BY rowid DESC LIMIT 1"));
  const reply=/MURMUR-DOCTOR-REPLY [a-f0-9]+$/.exec(challenge.text)?.[0];assert.ok(reply);
  const proof=await pending;assert.equal(proof.peerId,'agent-b');
  assert.equal(read('agent-a',"SELECT text FROM local_messages WHERE msg_id=?",proof.replyMsgId).text,reply);
  await until(()=>read('agent-a',"SELECT status FROM outbox WHERE msg_id=?",proof.msgId)?.status==='acked');
  for (const [id,msgId] of [['agent-a',proof.replyMsgId],['agent-b',proof.msgId]]) {
    const row=read(id,"SELECT wake_eligible,wake_status,wake_attempts FROM local_messages WHERE msg_id=?",msgId);
    assert.deepEqual({...row},{wake_eligible:0,wake_status:'muted',wake_attempts:0});
  }
  // Authenticate before the protocol handler: an invalid signature must not
  // persist or produce a reply, even when its plaintext would be a valid probe.
  const original=JSON.parse(read('agent-a','SELECT envelope_json FROM outbox WHERE msg_id=?',proof.msgId).envelope_json);
  const forged={...original,msgId:randomUUID(),signature:'invalid'};
  const acks=nc.subscribe('ack.agent-a');let rejection;
  const receiver=(async()=>{for await(const message of acks){const ack=JSON.parse(StringCodec().decode(message.data));if(ack.msgId===forged.msgId)rejection=ack;}})();
  await nc.flush();nc.publish('msg.agent-b',StringCodec().encode(JSON.stringify(forged)));await nc.flush();
  try { await until(()=>rejection);assert.equal(rejection.status,'nack'); }
  finally { acks.unsubscribe();await receiver; }
  assert.equal(read('agent-b','SELECT msg_id FROM local_messages WHERE msg_id=?',forged.msgId),undefined);
  // A signed request for a different recipient is stored only and gets no reply.
  const wrongTarget={...original,msgId:randomUUID(),recipients:['someone-else']};
  wrongTarget.signature=await signEnvelope(stableEnvelopePayload(wrongTarget),config.keys.signing.privateKey);
  nc.publish('msg.agent-b',StringCodec().encode(JSON.stringify(wrongTarget)));await nc.flush();
  const wrongRow=await until(()=>read('agent-b','SELECT wake_eligible,wake_status FROM local_messages WHERE msg_id=?',wrongTarget.msgId));
  assert.deepEqual({...wrongRow},{wake_eligible:0,wake_status:'muted'});
  assert.equal(read('agent-b','SELECT count(*) n FROM outbox').n,1);
  if (['darwin', 'linux'].includes(process.platform)) {
    const report = await runDoctor({ context, adapter: platformAdapter(), peer: 'agent-b', timeoutMs: 10000 });
    assert.equal(report.schema, 'murmur.doctor/1');
    assert.equal(report.peerCheck.state, 'connected');
    assert.equal(report.peerCheck.peerId, 'agent-b');
    assert.ok(report.peerCheck.lastExchangeAt);
    assert.ok(read('agent-a', "SELECT msg_id FROM local_messages WHERE msg_id=?", report.peerCheck.replyMsgId));
    assert.equal(report.stages.find(row => row.id === 'daemon').state, 'ok');
    assert.equal(report.stages.find(row => row.id === 'roundtrip').state, 'ok');
    assert.equal(report.stages.find(row => row.id === 'wake').reason, 'wake.no-responder');
  }
});
