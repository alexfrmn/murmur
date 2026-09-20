import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createKeyPair, createSigningKeyPair } from '../packages/security/dist/src/index.js';
import { SQLiteMessageStore } from '../packages/core/dist/src/index.js';
import { resolveContext } from '../packages/setup/dist/src/paths.js';
import { migrateBroker } from '../packages/setup/dist/src/broker-migration.js';
import { main } from '../packages/setup/dist/src/cli.js';
import { cliErrorText } from '../packages/setup/dist/src/cli-error.js';
const root=new URL('../',import.meta.url).pathname;
const profileFree=async()=>({state:'free',reason:'test.fixture-exclusive'});

test('hard-linked profile refusal keeps state and explains inspection and retry without raw details', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-migrate-links-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const context = resolveContext({ dataDir: dir, repoRoot: root });
  const config = { agentId: 'agent-a', subject: 'msg.agent-a', natsUrl: 'nats://127.0.0.1:4222',
    keys: { encryption: await createKeyPair(), signing: await createSigningKeyPair() }, peers: {} };
  const before = JSON.stringify(config);
  await fs.writeFile(context.configPath, before, { mode: 0o600 });
  const adapter = {
    status: async () => ({ state: 'stopped', pid: null }),
    profileUsage: async () => ({ state: 'unknown', reason: 'profile-usage.profile-hard-linked',
      path: '/private/do-not-print', secret: 'DO_NOT_PRINT' }),
  };
  let refusal;
  await assert.rejects(main(['broker', 'migrate', '--data-dir', dir, '--broker-url',
    'tls://broker.example:4222', '--apply'], adapter), error => {
    refusal = error;
    return error.message === 'migration.profile-hard-linked';
  });
  assert.equal(await fs.readFile(context.configPath, 'utf8'), before);
  assert.deepEqual(await fs.readdir(dir), ['agent-config.json']);
  const text = cliErrorText(refusal);
  assert.match(text, /^migration\.profile-hard-linked\n/);
  assert.match(text, /another hard-link name/);
  assert.match(text, /files were kept/);
  assert.match(text, /same volume/);
  assert.match(text, /retry migration/);
  assert.match(text, /docs\/setup-onboarding\.md#files-with-more-than-one-name/);
  for (const hidden of ['DO_NOT_PRINT', '/private/do-not-print', config.keys.encryption.privateKey]) assert.ok(!text.includes(hidden));
  assert.equal(cliErrorText(new Error('DO_NOT_PRINT')), 'operation-failed');
  const unavailable = cliErrorText(new Error('migration.profile-usage-unavailable'));
  assert.match(unavailable, /could not inspect every process/);
  assert.match(unavailable, /files were kept/);
  assert.match(unavailable, /cannot force migration/);
});

test('broker migration dry-run is inert and apply preserves unrelated state with private backup', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'murmur-migrate-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const context=resolveContext({dataDir:dir,repoRoot:root});await fs.mkdir(dir,{recursive:true});
  const peerKeys={encryption:await createKeyPair(),signing:await createSigningKeyPair()};
  const legacy={agentId:'agent-a',subject:'msg.agent-a',natsUrl:'nats://remote.example:4222',natsToken:'old-secret',
    keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},peers:{'agent-b':{subject:'msg.agent-b',encryption:{publicKey:peerKeys.encryption.publicKey},signing:{publicKey:peerKeys.signing.publicKey}}},wake:{enabled:false},custom:{keep:true}};
  await fs.writeFile(context.configPath,JSON.stringify(legacy),{mode:0o600});
  const messages=new SQLiteMessageStore(context.storePath);await messages.append({msgId:'kept-message',conversationId:'kept-conversation',sender:'agent-b',direction:'inbound',text:'history survives',createdAt:new Date().toISOString()});messages.close();
  const cursor=path.join(dir,'read-state.json');await fs.writeFile(cursor,JSON.stringify({schema:'murmur.read/1',agentId:'agent-a',rowid:1}),{mode:0o600});const cursorBefore=await fs.readFile(cursor,'utf8');
  const user=path.join(dir,'user'),pass=path.join(dir,'pass'),ca=path.join(dir,'ca');
  await fs.writeFile(user,'alice',{mode:0o600});await fs.writeFile(pass,'new-secret',{mode:0o600});await fs.writeFile(ca,'CA',{mode:0o644});
  const adapter={manager:'none',profileUsage:profileFree,status:async()=>({state:'stopped',manager:'none',pid:null,since:null,lastExitCode:null,observedStorePath:null,restartCount:null,restartWindowMs:null})};
  const before=await fs.readFile(context.configPath,'utf8');
  const args=['broker','migrate','--data-dir',dir,'--broker-url','tls://broker.example:4222','--user-file',user,'--password-file',pass,'--ca-file',ca];
  const dry=await main(args,adapter);
  assert.equal(dry.applied,false);assert.equal(await fs.readFile(context.configPath,'utf8'),before);assert.ok(!JSON.stringify(dry).includes('secret'));
  assert.deepEqual(dry.from,{scheme:'nats:',auth:'token'});assert.deepEqual(dry.to,{scheme:'tls:',auth:'user-password'});
  const result=await main([...args,'--apply'],adapter);
  const next=JSON.parse(await fs.readFile(context.configPath,'utf8'));
  assert.equal(next.natsUser,'alice');assert.equal(next.natsPassword,'new-secret');assert.equal(next.natsToken,undefined);
  assert.deepEqual(next.keys,legacy.keys);assert.deepEqual(next.peers,legacy.peers);assert.deepEqual(next.custom,{keep:true});assert.equal(next.wake.enabled,false);
  const db=new DatabaseSync(context.storePath,{readOnly:true});assert.equal(db.prepare("SELECT text FROM local_messages WHERE msg_id='kept-message'").get().text,'history survives');db.close();assert.equal(await fs.readFile(cursor,'utf8'),cursorBefore);
  assert.equal((await fs.stat(result.backup)).mode&0o777,0o600);assert.equal(await fs.readFile(result.backup,'utf8'),before);
  assert.equal(result.restartRequired,true);
  const again=await migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',userFile:user,passwordFile:pass,caFile:ca,apply:true});
  assert.deepEqual({applied:again.applied,changed:again.changed,backup:again.backup,restartRequired:again.restartRequired},{applied:false,changed:false,backup:null,restartRequired:false});
});

test('migration rejects a changed credential/CA candidate between preview and commit', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'murmur-migrate-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const context=resolveContext({dataDir:dir,repoRoot:root});await fs.mkdir(dir,{recursive:true});
  const legacy={agentId:'agent-a',subject:'msg.agent-a',natsUrl:'nats://remote.example:4222',keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},peers:{}};await fs.writeFile(context.configPath,JSON.stringify(legacy),{mode:0o600});
  const user=path.join(dir,'user'),pass=path.join(dir,'pass'),ca=path.join(dir,'ca');await fs.writeFile(user,'alice',{mode:0o600});await fs.writeFile(pass,'first',{mode:0o600});await fs.writeFile(ca,'CA-ONE',{mode:0o644});const before=await fs.readFile(context.configPath,'utf8');
  const adapter={manager:'systemd',profileUsage:profileFree,status:async()=>{await fs.writeFile(pass,'second',{mode:0o600});await fs.writeFile(ca,'CA-TWO',{mode:0o644});return {state:'stopped',manager:'systemd',pid:null,since:null,lastExitCode:null,observedStorePath:null,restartCount:null,restartWindowMs:null}}};
  await assert.rejects(migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',userFile:user,passwordFile:pass,caFile:ca,apply:true}),/migration.input-changed/);
  assert.equal(await fs.readFile(context.configPath,'utf8'),before);assert.equal((await fs.readdir(dir)).filter(x=>x.startsWith('agent-config.backup-')).length,0);
});

test('migration rejects byte changes even when the parsed config is unchanged', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'murmur-migrate-config-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const context=resolveContext({dataDir:dir,repoRoot:root});await fs.mkdir(dir,{recursive:true});
  const legacy={agentId:'agent-a',subject:'msg.agent-a',natsUrl:'nats://remote.example:4222',keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},peers:{}};
  const before=JSON.stringify(legacy);await fs.writeFile(context.configPath,before,{mode:0o600});
  const adapter={manager:'none',profileUsage:profileFree,status:async()=>{await fs.writeFile(context.configPath,before+'\n',{mode:0o600});return {state:'stopped',manager:'none',pid:null,since:null,lastExitCode:null,observedStorePath:null,restartCount:null,restartWindowMs:null}}};
  await assert.rejects(migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',apply:true}),/migration.config-changed/);
  assert.equal(await fs.readFile(context.configPath,'utf8'),before+'\n');assert.equal((await fs.readdir(dir)).filter(x=>x.startsWith('agent-config.backup-')).length,0);
});

test('CLI rejects broker-file options on unrelated commands', async () => {
  await assert.rejects(main(['version','--token-file','/not-read']),/cli.option-not-supported/);
  await assert.rejects(main(['status','--ca-file','/not-read']),/cli.option-not-supported/);
  await assert.rejects(main(['version','--broker-url','tls://broker.example:4222']),/cli.option-not-supported/);
  await assert.rejects(main(['join','--broker-url','tls://broker.example:4222']),/cli.option-not-supported/);
});

test('migration refuses a running managed service before mutation', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'murmur-migrate-running-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const context=resolveContext({dataDir:dir,repoRoot:root});await fs.mkdir(dir,{recursive:true});
  const legacy={agentId:'agent-a',subject:'msg.agent-a',natsUrl:'nats://remote.example:4222',keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},peers:{}};
  await fs.writeFile(context.configPath,JSON.stringify(legacy),{mode:0o600});const before=await fs.readFile(context.configPath,'utf8');
  const adapter={manager:'systemd',status:async()=>({state:'running',manager:'systemd',pid:1,since:null,lastExitCode:null,observedStorePath:null,restartCount:null,restartWindowMs:null})};
  await assert.rejects(migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',apply:true}),/migration.service-must-be-stopped/);
  assert.equal(await fs.readFile(context.configPath,'utf8'),before);
});

test('migration refuses stopped or absent service when profile usage is unknown', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'murmur-migrate-unknown-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const context=resolveContext({dataDir:dir,repoRoot:root});await fs.mkdir(dir,{recursive:true});
  const legacy={agentId:'agent-a',subject:'msg.agent-a',natsUrl:'nats://remote.example:4222',keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},peers:{}};
  await fs.writeFile(context.configPath,JSON.stringify(legacy),{mode:0o600});const before=await fs.readFile(context.configPath);
  const adapter={manager:'none',status:async()=>({state:'stopped',manager:'none',pid:null,since:null,lastExitCode:null,observedStorePath:null,restartCount:null,restartWindowMs:null})};
  await assert.rejects(migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',apply:true}),/migration.profile-usage-unavailable/);
  assert.deepEqual(await fs.readFile(context.configPath),before);assert.equal((await fs.readdir(dir)).filter(x=>x.startsWith('agent-config.backup-')).length,0);
});

test('migration refuses a live or malformed daemon observation even when a probe says free', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'murmur-migrate-observed-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const context=resolveContext({dataDir:dir,repoRoot:root});await fs.mkdir(dir,{recursive:true});await fs.writeFile(context.storePath,'',{mode:0o600});
  const legacy={agentId:'agent-a',subject:'msg.agent-a',natsUrl:'nats://remote.example:4222',keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},peers:{}};
  await fs.writeFile(context.configPath,JSON.stringify(legacy),{mode:0o600});const before=await fs.readFile(context.configPath);
  const adapter={manager:'none',profileUsage:profileFree,status:async()=>({state:'stopped',manager:'none',pid:null,since:null,lastExitCode:null,observedStorePath:null,restartCount:null,restartWindowMs:null})};
  await fs.writeFile(path.join(dir,'daemon-observation.json'),JSON.stringify({schema:'murmur.runtime/1',agentId:'agent-a',pid:process.pid,storePath:context.storePath}),{mode:0o600});
  await assert.rejects(migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',apply:true}),/migration.profile-in-use/);
  await fs.writeFile(path.join(dir,'daemon-observation.json'),'{}',{mode:0o600});
  let refusal;
  await assert.rejects(migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',apply:true}),error=>{
    refusal=error;return error.message==='migration.runtime-unverifiable';
  });
  const explanation=cliErrorText(refusal);
  assert.match(explanation,/could not verify the daemon observation/);
  assert.match(explanation,/files were kept/);
  assert.match(explanation,/Do not delete the observation or recreate the profile/);
  for(const hidden of [dir,legacy.keys.encryption.privateKey,legacy.keys.signing.privateKey]) assert.ok(!explanation.includes(hidden));
  assert.equal(await fs.readFile(path.join(dir,'daemon-observation.json'),'utf8'),'{}');
  assert.deepEqual(await fs.readFile(context.configPath),before);assert.equal((await fs.readdir(dir)).filter(x=>x.startsWith('agent-config.backup-')).length,0);
});

test('migration restores exact bytes and removes backup when the config writer changes then fails', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'murmur-migrate-rollback-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const fakeRoot=path.join(dir,'runtime');await fs.mkdir(path.join(fakeRoot,'scripts'),{recursive:true});
  await fs.writeFile(path.join(fakeRoot,'scripts','secure-state.mjs'),`import { writeFile } from 'node:fs/promises';\nexport async function writePrivateJson(file){ await writeFile(file,'CORRUPTED'); throw new Error('synthetic-write-failure'); }\n`);
  const profile=path.join(dir,'profile');await fs.mkdir(profile);const context=resolveContext({dataDir:profile,repoRoot:fakeRoot});
  const legacy={agentId:'agent-a',subject:'msg.agent-a',natsUrl:'nats://remote.example:4222',keys:{encryption:await createKeyPair(),signing:await createSigningKeyPair()},peers:{},custom:{preserved:true}};
  const before=Buffer.from(JSON.stringify(legacy)+'  \n');await fs.writeFile(context.configPath,before,{mode:0o600});
  const adapter={manager:'none',profileUsage:profileFree,status:async()=>({state:'stopped',manager:'none',pid:null,since:null,lastExitCode:null,observedStorePath:null,restartCount:null,restartWindowMs:null})};
  await assert.rejects(migrateBroker(context,adapter,{brokerUrl:'tls://broker.example:4222',apply:true}),/migration.config-write-failed/);
  assert.deepEqual(await fs.readFile(context.configPath),before);assert.equal((await fs.readdir(profile)).filter(x=>x.startsWith('agent-config.backup-')).length,0);
});
