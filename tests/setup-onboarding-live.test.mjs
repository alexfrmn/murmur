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
import { runDoctor } from '../packages/setup/dist/src/doctor.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
const exec=promisify(execFile), root=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) { const end=Date.now()+12000; while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await delay(50);}throw new Error('onboarding-live.timeout'); }
async function stop(child) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  const done=new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM');
  const timeout=setTimeout(()=>child.kill('SIGKILL'),3000); try{await done;}finally{clearTimeout(timeout);}
}
test('TLS CLI onboarding, doctor, and two daemons prove an authenticated persisted roundtrip', { timeout:40000 }, async t=>{
  execFileSync('nats-server',['--version'],{stdio:'ignore'});execFileSync('openssl',['version'],{stdio:'ignore'});
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'murmur-onboard-live-'))), children=[];
  let nc; t.after(async()=>{if(nc)await nc.close();for(const child of children.reverse())await stop(child);await fs.rm(base,{recursive:true,force:true});});
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',path.join(base,'server.key'),'-out',path.join(base,'server.crt')],{stdio:'ignore'});
  execFileSync(process.execPath,['packages/broker-nats/integration/write-secure-config.mjs',base,String(port)],{cwd:root,stdio:'ignore'});
  const url=`tls://127.0.0.1:${port}`;
  children.push(spawn('nats-server',['-c',path.join(base,'nats.conf')],{stdio:'ignore'}));
  nc=await until(async()=>connect({servers:url,user:'agent-a',pass:'test-password-a',tls:{caFile:path.join(base,'server.crt'),servername:'localhost'},reconnect:false,timeout:100}));
  const env=id=>({PATH:process.env.PATH,HOME:base,DATA_DIR:path.join(base,id)});
  const cli=async(id,...args)=>JSON.parse((await exec(process.execPath,['packages/setup/bin/murmur.mjs',...args,'--data-dir',path.join(base,id),'--json'],{cwd:root,env:env(id)})).stdout);
  const credentialFiles={};
  for(const id of ['agent-a','agent-b']){const user=path.join(base,`${id}.user`),pass=path.join(base,`${id}.pass`);await fs.writeFile(user,id,{mode:0o600});await fs.writeFile(pass,`test-password-${id.at(-1)}`,{mode:0o600});credentialFiles[id]=[user,pass];}
  const auth=id=>['--user-file',credentialFiles[id][0],'--password-file',credentialFiles[id][1],'--ca-file',path.join(base,'server.crt'),'--server-name','localhost'];
  await cli('agent-a','init','--agent-id','agent-a','--broker-url',url,...auth('agent-a'));
  await cli('agent-a','invite','--out',path.join(base,'invite'));
  assert.equal((await cli('agent-b','join','--agent-id','agent-b','--invite-file',path.join(base,'invite'),'--reply-out',path.join(base,'reply'),...auth('agent-b'))).paired,null);
  await cli('agent-a','add-peer','--reply-file',path.join(base,'reply'));
  for(const id of ['agent-a','agent-b']) children.push(spawn(process.execPath,['scripts/murmur-daemon.mjs'],{cwd:root,env:env(id),stdio:'ignore'}));
  const read=(id,sql,...params)=>{const db=new DatabaseSync(path.join(base,id,'murmur.db'),{readOnly:true});try{return db.prepare(sql).get(...params);}finally{db.close();}};
  for(const id of ['agent-a','agent-b']) await until(async()=>{
    const observation=JSON.parse(await fs.readFile(path.join(base,id,'daemon-observation.json'),'utf8'));
    return observation.broker?.state==='connected';
  });
  const context=resolveContext({dataDir:path.join(base,'agent-a'),repoRoot:root});
  const config=JSON.parse(await fs.readFile(context.configPath,'utf8'));
  const adapter={manager:'none',status:async()=>({state:'running',manager:'none',pid:process.pid,since:new Date().toISOString(),lastExitCode:null,observedStorePath:context.storePath,restartCount:0,restartWindowMs:3600000}),detectClients:async()=>[],install:async()=>{},start:async()=>{},stop:async()=>{}};
  const pending=runDoctor({context,adapter,peer:'agent-b',timeoutMs:10000}); pending.catch(()=>{});
  const challenge=await until(()=>read('agent-b',"SELECT text,conversation_id FROM local_messages WHERE direction='inbound' AND conversation_id LIKE 'murmur:doctor:%' ORDER BY rowid DESC LIMIT 1"));
  const reply=/MURMUR-DOCTOR-REPLY [a-f0-9]+$/.exec(challenge.text)?.[0];assert.ok(reply);
  const sender=spawn(process.execPath,['scripts/murmur-shell-send.mjs','--to','agent-a','--conv',challenge.conversation_id,'--stdin'],{cwd:root,env:env('agent-b'),stdio:['pipe','ignore','ignore']});children.push(sender);sender.stdin.end(reply);
  assert.equal(await new Promise(r=>sender.once('exit',r)),0);
  const report=await pending;assert.equal(report.summary.failedStage,null);assert.equal(report.stages.find(s=>s.id==='roundtrip').state,'ok');
  const stored=await until(()=>read('agent-a',"SELECT msg_id,text FROM local_messages WHERE text=?",reply));assert.equal(stored.text,reply);
  const original=await fs.readFile(context.configPath,'utf8');const wrong={...config,natsPassword:'wrong-live-secret'};await fs.writeFile(context.configPath,JSON.stringify(wrong),{mode:0o600});
  const negative=await runDoctor({context,adapter,timeoutMs:1000});await fs.writeFile(context.configPath,original,{mode:0o600});
  assert.equal(negative.summary.failedStage,'broker');assert.equal(negative.stages.find(s=>s.id==='broker').reason,'broker.unauthorized');
  assert.ok(!JSON.stringify(negative).includes('wrong-live-secret'));

  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=untrusted','-keyout',path.join(base,'untrusted.key'),'-out',path.join(base,'untrusted.crt')],{stdio:'ignore'});
  const untrusted={...config,natsTls:{...config.natsTls,caFile:path.join(base,'untrusted.crt')}};
  await fs.writeFile(context.configPath,JSON.stringify(untrusted),{mode:0o600});
  const wrongCa=await runDoctor({context,adapter,timeoutMs:1000});assert.equal(wrongCa.summary.failedStage,'broker');assert.equal(wrongCa.stages.find(s=>s.id==='broker').reason,'broker.unreachable');
  const wrongHostname={...config,natsTls:{...config.natsTls,serverName:'wrong-host.example'}};
  await fs.writeFile(context.configPath,JSON.stringify(wrongHostname),{mode:0o600});
  const hostname=await runDoctor({context,adapter,timeoutMs:1000});await fs.writeFile(context.configPath,original,{mode:0o600});
  assert.equal(hostname.summary.failedStage,'broker');assert.equal(hostname.stages.find(s=>s.id==='broker').reason,'broker.unreachable');

  const denied=(async()=>{for await(const event of nc.status())if(event.type==='error'&&String(event.data).includes('PERMISSIONS_VIOLATION'))return event;})();
  nc.publish('msg.agent-a',Buffer.from('denied-by-generated-agent-acl'));await nc.flush().catch(()=>{});
  assert.ok(await Promise.race([denied,delay(2000).then(()=>undefined)]),'setup-created agent credentials must retain the generated restricted publish ACL');
});
