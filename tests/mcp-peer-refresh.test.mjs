import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { AgentConfigCache } from '../packages/mcp-server/dist/src/agent-config.js';
import { decryptPayload, verifyEnvelopeSignature } from '../packages/security/dist/src/index.js';
import { stableEnvelopePayload } from '../packages/core/dist/src/index.js';

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'murmur-peer-refresh-')));
  const children=[];
  t.after(async()=>{for(const {child,closed} of children){if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;}
    await fs.rm(root,{recursive:true,force:true,maxRetries:5});});
  const cli=(id,...args)=>JSON.parse(execFileSync(process.execPath,['packages/setup/bin/murmur.mjs',...args,'--data-dir',path.join(root,id),'--json'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,HOME:root,MURMUR_UPDATE_CHECK:'0'}}));
  cli('a','init','--agent-id','agent-a','--broker-url','nats://127.0.0.1:1');
  const configFile=path.join(root,'a','agent-config.json');
  const config=JSON.parse(await fs.readFile(configFile,'utf8'));
  const save=async value=>{const tmp=path.join(root,'a','config-new.json');await fs.writeFile(tmp,JSON.stringify(value),{mode:0o600});await fs.rename(tmp,configFile);};
  const client=()=>{
    const child=spawn(process.execPath,['packages/mcp-server/dist/src/index.js'],{env:{...process.env,HOME:root,DATA_DIR:path.join(root,'a'),
      MURMUR_STORE_PATH:path.join(root,'a','murmur.db'),MURMUR_CHANNEL_ROSTER_PATH:path.join(root,'a','channel-roster.db')},stdio:['pipe','pipe','pipe']});
    const closed=new Promise(resolve=>child.once('close',resolve));children.push({child,closed});child.stderr.resume();
    const pending=new Map();let counter=0;
    createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line);pending.get(response.id)?.(response);});
    return async(name,args={},error)=>{
      const id=++counter;let timer;
      try {
        const result=await new Promise((resolve,reject)=>{pending.set(id,resolve);timer=setTimeout(()=>reject(new Error('MCP test timed out')),8000);
          child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');});
        if(error){assert.match(result.error?.message??'',error);return;}
        assert.equal(result.error,undefined,result.error?.message);return JSON.parse(result.result.content[0].text);
      } finally {clearTimeout(timer);pending.delete(id);}
    };
  };
  const rows=()=>{const db=new DatabaseSync(path.join(root,'a','murmur.db'),{readOnly:true});try{return db.prepare('SELECT envelope_json FROM outbox').all();}finally{db.close();}};
  return {root,cli,config,configFile,save,client,rows};
}

test('a running MCP sees add-peer and sends with its new key without restarting the client', {timeout:20000}, async t=>{
  const f=await fixture(t), call=f.client();
  assert.deepEqual((await call('murmur_peers')).peers,[]);
  f.cli('a','invite','--out',path.join(f.root,'invite.txt'));
  f.cli('b','join','--agent-id','agent-b','--invite-file',path.join(f.root,'invite.txt'),'--reply-out',path.join(f.root,'reply.txt'));
  f.cli('a','add-peer','--reply-file',path.join(f.root,'reply.txt'));
  // A send on the cache-miss path must work even before murmur_peers refreshes.
  const sent=await call('murmur_send',{to:'agent-b',text:'fresh peer'});
  assert.equal(sent.status,'queued');assert.equal((await call('murmur_peers')).peers[0].agentId,'agent-b');
  const peer=JSON.parse(await fs.readFile(path.join(f.root,'b','agent-config.json'),'utf8'));
  const envelope=JSON.parse(f.rows()[0].envelope_json);
  assert.equal(await verifyEnvelopeSignature(stableEnvelopePayload(envelope),envelope.signature,f.config.keys.signing.publicKey),true);
  assert.equal(await decryptPayload({ciphertext:envelope.payloadCiphertext,nonce:envelope.payloadNonce,senderPublicKey:f.config.keys.encryption.publicKey},peer.keys.encryption.privateKey),'fresh peer');
  const requested=await call('murmur_request',{to:'agent-b',text:'new request',timeout_ms:100,poll_interval_ms:10});
  assert.equal(requested.status,'awaiting_reply');assert.equal(f.rows().length,2);
  assert.deepEqual(requested.delivery,{status:'pending',acknowledged:false,outboxStatus:'pending'});
  assert.equal(requested.timeout_ms,100);assert.match(requested.hint,/do not resend/);
  await call('murmur_request',{to:'agent-b',text:'invalid wait',timeout_ms:-1},/timeout_ms/);
  assert.equal(f.rows().length,2);
  const refreshed=JSON.parse(await fs.readFile(f.configFile,'utf8'));
  await f.save({...refreshed,peers:{}});
  await call('murmur_send',{to:'agent-b',text:'must not enqueue'},/unknown peer/);
  assert.equal(f.rows().length,2);assert.deepEqual((await call('murmur_peers')).peers,[]);
});

test('config failures clear cached peers and identity/runtime changes fail closed', {timeout:15000}, async t=>{
  const f=await fixture(t), call=f.client();
  await call('murmur_peers');
  await fs.writeFile(f.configFile,'{invalid');
  await call('murmur_peers',{},/agent-config-unavailable/);
  await call('murmur_send',{to:'agent-b',text:'must not use cached config'},/agent-config-unavailable/);
  await f.save({...f.config,agentId:'different'});
  await call('murmur_peers',{},/agent-config-identity-changed-restart-required/);
  await f.save({...f.config,keys:{...f.config.keys,signing:{...f.config.keys.signing,privateKey:'changed'}}});
  await call('murmur_peers',{},/agent-config-identity-changed-restart-required/);
  await f.save({...f.config,natsUrl:'nats://127.0.0.1:2'});
  await call('murmur_peers',{},/agent-config-runtime-changed-restart-required/);
  await f.save(f.config);assert.equal((await call('murmur_peers')).agentId,'agent-a');
  assert.equal(f.rows().length,0);
});

test('cache checks path identity, symlinks and deletion before returning an unchanged snapshot', async t=>{
  const f=await fixture(t), cache=new AgentConfigCache(f.configFile);
  const original=cache.read();assert.equal(cache.read(),original);
  await f.save({...f.config,peers:{added:{subject:'msg.added'}}});
  assert.ok(cache.read().peers.added);
  await fs.unlink(f.configFile);assert.throws(()=>cache.read(),/agent-config-unavailable/);
  await fs.mkdir(f.configFile);assert.throws(()=>cache.read(),/agent-config-file-invalid/);
  await fs.rmdir(f.configFile);await f.save(f.config);
  if(process.platform!=='win32'){
    const target=path.join(f.root,'elsewhere.json');await fs.rename(f.configFile,target);await fs.symlink(target,f.configFile);
    assert.throws(()=>cache.read(),/agent-config-file-invalid/);
  }
});
