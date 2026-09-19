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
import { connect } from 'nats';
import { probeRoundtrip } from '../packages/setup/dist/src/doctor.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
const exec=promisify(execFile), root=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) { const end=Date.now()+12000; while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await delay(50);}throw new Error('onboarding-live.timeout'); }
async function stop(child) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  const done=new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM');
  const timeout=setTimeout(()=>child.kill('SIGKILL'),3000); try{await done;}finally{clearTimeout(timeout);}
}
test('CLI invite handshake runs two real daemons and proves encrypted persisted roundtrip', { timeout:30000 }, async t=>{
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
  await cli('agent-a','invite','--out',path.join(base,'invite'));
  assert.equal((await cli('agent-b','join','--agent-id','agent-b','--invite-file',path.join(base,'invite'),'--reply-out',path.join(base,'reply'))).paired,null);
  await cli('agent-a','add-peer','--reply-file',path.join(base,'reply'));
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
  const sender=spawn(process.execPath,['scripts/murmur-shell-send.mjs','--to','agent-a','--conv',challenge.conversation_id,'--stdin'],{cwd:root,env:env('agent-b'),stdio:['pipe','ignore','ignore']});children.push(sender);sender.stdin.end(reply);
  assert.equal(await new Promise(r=>sender.once('exit',r)),0);
  const proof=await pending;assert.equal(proof.peerId,'agent-b');
  assert.equal(read('agent-a',"SELECT text FROM local_messages WHERE msg_id=?",proof.replyMsgId).text,reply);
  await until(()=>read('agent-a',"SELECT status FROM outbox WHERE msg_id=?",proof.msgId)?.status==='acked');
});
