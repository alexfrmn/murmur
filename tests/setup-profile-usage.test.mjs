import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDarwinAdapter } from '../packages/setup/dist/src/platform/darwin.js';
import { createLinuxAdapter } from '../packages/setup/dist/src/platform/linux.js';

const unixOnly = { skip: typeof process.getuid !== 'function' };

async function contextFixture(t) {
  // macOS temp roots may use /var aliases; selected profile contexts are canonical.
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'murmur-profile-usage-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'profile');
  const repoRoot = path.join(home, 'repo');
  await fs.mkdir(path.join(dataDir, 'logs'), { recursive: true });
  await fs.chmod(dataDir, 0o700);
  await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'agent-config.json'), '{}');
  await fs.chmod(path.join(dataDir, 'agent-config.json'), 0o600);
  await fs.writeFile(path.join(dataDir, 'murmur.db'), 'fixture');
  const context = {
    dataDir,
    configPath: path.join(dataDir, 'agent-config.json'),
    storePath: path.join(dataDir, 'murmur.db'),
    repoRoot,
    nodePath: process.execPath,
    logDir: path.join(dataDir, 'logs'),
    serviceName: 'murmur-profile-usage-test',
  };
  return { home, context };
}

async function fakeProcess(procRoot, pid, uid, targets) {
  const root = path.join(procRoot, String(pid));
  await fs.mkdir(path.join(root, 'fd'), { recursive: true });
  const fields = Array.from({ length: 20 }, (_, index) => index === 0 ? 'S' : index === 19 ? `${pid}00` : '0');
  await fs.writeFile(path.join(root, 'stat'), `${pid} (fixture process) ${fields.join(' ')}\n`);
  const uids = Array.isArray(uid) ? uid : [uid, uid, uid, uid];
  await fs.writeFile(path.join(root, 'status'), `Name:\tfixture\nUid:\t${uids.join('\t')}\n`);
  for (const [index, target] of targets.entries()) await fs.symlink(target, path.join(root, 'fd', String(index)));
}

async function addLinuxVisibilityAnchors(procRoot) {
  for (const pid of new Set([1, process.ppid])) {
    if (pid !== process.pid) await fakeProcess(procRoot, pid, pid === 1 ? 0 : process.getuid(), []);
  }
}

const fixedStart = 'Sun Sep 20 16:30:38 2026';
const visibilityAnchors = [...new Set([1, process.ppid])].filter(pid => pid !== process.pid);
const pipeRecord = pid => `p${pid}\nf3\ntPIPE\nn->0x0\n`;
function psReply(observerPID, entries, uid = process.getuid(), observerUID = uid, includeAnchors = true) {
  const rows = [...entries];
  if (includeAnchors) {
    for (const pid of visibilityAnchors) {
      if (!rows.some(row => row.pid === pid)) rows.push({ pid, uid: pid === 1 ? 0 : uid, state: 'S', start: fixedStart });
    }
  }
  rows.push({ pid: observerPID, uid: observerUID, state: 'R', start: fixedStart });
  return {
    code: 0, pid: observerPID, stderr: '',
    stdout: rows.map(row => `${row.pid} ${row.uid ?? uid} ${row.state ?? 'S'} ${row.start ?? fixedStart}`).join('\n') + '\n',
  };
}
function lsofReply(stdout, pid = 71999, code = 0, stderr = '', includeAnchors = true) {
  const prefix = includeAnchors ? visibilityAnchors.filter(anchor => !stdout.includes(`p${anchor}\n`)).map(pipeRecord).join('') : '';
  return { code, stdout: prefix + stdout, stderr, pid };
}
function scriptedProfileRun(replies, calls = []) {
  let index = 0;
  return async (file, args) => {
    calls.push([file, args]);
    assert.ok(index < replies.length, `unexpected profile probe call ${file}`);
    return replies[index++];
  };
}
const regularRecord = (pid, descriptor, name) => `p${pid}\nf${descriptor}\ntREG\nn${name}\n`;

test('Linux profile usage excludes only itself and reports another same-UID open file', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const procRoot = path.join(home, 'proc');
  await addLinuxVisibilityAnchors(procRoot);
  await fs.mkdir(path.join(procRoot, String(process.pid), 'fd'), { recursive: true });
  await fs.symlink(context.configPath, path.join(procRoot, String(process.pid), 'fd', '7'));
  const externalAlias = path.join(home, 'store-alias');
  await fs.symlink(context.storePath, externalAlias);
  await fakeProcess(procRoot, 42001, process.getuid(), [externalAlias]);
  const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
});

test('Linux profile usage reports free only after stable process and profile snapshots', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const procRoot = path.join(home, 'proc');
  await addLinuxVisibilityAnchors(procRoot);
  const outside = path.join(home, 'outside');
  await fs.writeFile(outside, 'fixture');
  await fs.mkdir(path.join(procRoot, String(process.pid)), { recursive: true });
  await fakeProcess(procRoot, 42002, process.getuid(), [outside, 'socket:[123]', 'anon_inode:[eventpoll]']);
  const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'free', reason: 'profile-usage.no-open-files' });
});

test('Linux profile usage includes every real, effective, saved, and filesystem UID', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const selected = process.getuid();
  const foreign = selected === 0 ? 1 : 0;
  for (let index = 0; index < 4; index++) {
    const procRoot = path.join(home, `proc-uid-${index}`); await fs.mkdir(procRoot);
    await addLinuxVisibilityAnchors(procRoot);
    const uids = [foreign, foreign, foreign, foreign]; uids[index] = selected;
    await fakeProcess(procRoot, 42100 + index, uids, [context.storePath]);
    const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
    assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
  }
});

test('Unix profile usage refuses a permissive profile root without changing it', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const original = await fs.readFile(context.configPath);
  await fs.chmod(context.dataDir, 0o755);
  const procRoot = path.join(home, 'proc-permissive'); await fs.mkdir(procRoot);
  const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'unknown', reason: 'profile-usage.profile-unverifiable' });
  assert.equal((await fs.stat(context.dataDir)).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readFile(context.configPath), original);
});

test('Linux profile usage reports a foreign-UID holder and refuses incomplete process visibility', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const procRoot = path.join(home, 'proc-foreign-holder'); await fs.mkdir(procRoot);
  await addLinuxVisibilityAnchors(procRoot);
  const foreign = process.getuid() === 0 ? 1 : 0;
  await fakeProcess(procRoot, 42009, foreign, [context.storePath]);
  const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });

  const hiddenRoot = path.join(home, 'proc-hidden'); await fs.mkdir(hiddenRoot);
  if (process.ppid !== 1 && process.ppid !== process.pid) await fakeProcess(hiddenRoot, process.ppid, process.getuid(), []);
  const hidden = createLinuxAdapter({ homeDir: home, procDir: hiddenRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await hidden.profileUsage(context), { state: 'unknown', reason: 'profile-usage.process-visibility-incomplete' });
});

test('Unix profile usage refuses a profile regular file with an external hardlink', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const alias = path.join(home, 'outside-store-hardlink');
  await fs.link(context.storePath, alias);
  const original = await fs.readFile(context.storePath);
  const procRoot = path.join(home, 'proc-hardlink'); await fs.mkdir(procRoot);
  let linuxCalls = 0, darwinCalls = 0;
  const linux = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => {
    linuxCalls++; return 'LoadState=not-found\n';
  } });
  const darwin = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: async () => {
    darwinCalls++; return { code: 0, stdout: '', stderr: '' };
  } });
  assert.deepEqual(await linux.profileUsage(context), { state: 'unknown', reason: 'profile-usage.profile-hard-linked' });
  assert.deepEqual(await darwin.profileUsage(context), { state: 'unknown', reason: 'profile-usage.profile-hard-linked' });
  assert.equal(linuxCalls, 0);
  assert.equal(darwinCalls, 0);
  assert.equal((await fs.stat(context.storePath)).nlink, 2);
  assert.deepEqual(await fs.readFile(context.storePath), original);
});

test('Linux profile usage fails closed for malformed process, deleted profile path, and aliased tree', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  for (const [name, prepare] of [
    ['malformed', async procRoot => {
      const root = path.join(procRoot, '42003');
      await fs.mkdir(path.join(root, 'fd'), { recursive: true });
      await fs.writeFile(path.join(root, 'stat'), 'malformed');
      await fs.writeFile(path.join(root, 'status'), 'Uid: malformed\n');
    }],
    ['deleted', procRoot => fakeProcess(procRoot, 42004, process.getuid(), [`${context.configPath} (deleted)`])],
  ]) {
    const procRoot = path.join(home, `proc-${name}`); await fs.mkdir(procRoot); await prepare(procRoot);
    await addLinuxVisibilityAnchors(procRoot);
    const adapter = createLinuxAdapter({ homeDir: home, procDir: procRoot, env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
    assert.equal((await adapter.profileUsage(context)).state, 'unknown');
  }
  await fs.symlink(path.join(home, 'outside'), path.join(context.dataDir, 'alias'));
  const adapter = createLinuxAdapter({ homeDir: home, procDir: path.join(home, 'missing-proc'), env: { PATH: '' }, run: async () => 'LoadState=not-found\n' });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'unknown', reason: 'profile-usage.profile-unverifiable' });
});

test('Darwin profile usage uses fixed lsof argv and reports another process open file', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const calls = [];
  const processes = [{ pid: process.pid }, { pid: 42005 }];
  const profileRun = scriptedProfileRun([
    psReply(71001, processes),
    lsofReply(regularRecord(process.pid, 9, context.configPath) + regularRecord(42005, 3, context.storePath)),
    psReply(71002, processes),
  ], calls);
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
  assert.deepEqual(calls, [
    ['/bin/ps', ['-axo', 'pid=,uid=,stat=,lstart=']],
    ['/usr/sbin/lsof', ['-n', '-P', '-Fpftn']],
    ['/bin/ps', ['-axo', 'pid=,uid=,stat=,lstart=']],
  ]);
});

test('Darwin profile usage requires its exact positive control and rejects lsof failure', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const calls = [];
  const current = [{ pid: process.pid }];
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71003, current), lsofReply(regularRecord(process.pid, 9, context.configPath)), psReply(71004, current),
  ], calls) });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'free', reason: 'profile-usage.no-open-files' });
  assert.equal(calls.length, 3);

  const failed = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71005, current), lsofReply('', 71006, -1),
  ]) });
  assert.deepEqual(await failed.profileUsage(context), { state: 'unknown', reason: 'profile-usage.probe-unavailable' });

  const missingControl = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71007, current), lsofReply(regularRecord(process.pid, 4, context.storePath)), psReply(71008, current),
  ]) });
  assert.deepEqual(await missingControl.profileUsage(context), { state: 'unknown', reason: 'profile-usage.control-unobserved' });
});

test('Darwin profile usage excludes only its current PID and handles an alias to the selected profile', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const alias = path.join(home, 'config-alias');
  await fs.symlink(context.configPath, alias);
  const processes = [{ pid: process.pid }, { pid: 42006 }];
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71009, processes),
    lsofReply(regularRecord(process.pid, 9, context.configPath) + regularRecord(42006, 3, alias)),
    psReply(71010, processes),
  ]) });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
});

test('Darwin profile usage excludes only a zombie verified in both snapshots', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const processes = [{ pid: process.pid }, { pid: 49430, state: 'Z', start: 'Tue Sep 15 14:16:39 2026' }];
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71011, processes), lsofReply(regularRecord(process.pid, 9, context.configPath)), psReply(71012, processes),
  ]) });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'free', reason: 'profile-usage.no-open-files' });
});

test('Darwin profile usage reports a foreign-UID holder and refuses a hidden system anchor', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const foreign = process.getuid() === 0 ? 1 : 0;
  const processes = [{ pid: process.pid }, { pid: 42010, uid: foreign }];
  const holder = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71029, processes),
    lsofReply(regularRecord(process.pid, 9, context.configPath) + regularRecord(42010, 3, context.storePath)),
    psReply(71030, processes),
  ]) });
  assert.deepEqual(await holder.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });

  const hidden = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71031, [{ pid: process.pid }], process.getuid(), 0, false),
  ]) });
  assert.deepEqual(await hidden.profileUsage(context), { state: 'unknown', reason: 'profile-usage.process-visibility-incomplete' });
});

test('Darwin profile usage verifies the exact setuid ps observer before filtering to the caller UID', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const current = [{ pid: process.pid }];
  const control = regularRecord(process.pid, 9, context.configPath);
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71024, current, process.getuid(), 0), lsofReply(control), psReply(71025, current, process.getuid(), 0),
  ]) });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'free', reason: 'profile-usage.no-open-files' });

  for (const observerPID of [undefined, 79999]) {
    const first = psReply(71026, current, process.getuid(), 0);
    if (observerPID === undefined) delete first.pid;
    else first.pid = observerPID;
    const refused = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([first]) });
    assert.deepEqual(await refused.profileUsage(context), { state: 'unknown', reason: 'profile-usage.process-unverifiable' });
  }
});

test('Darwin profile usage fails closed for missing process coverage, churn, warnings, and invalid file types', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const current = [{ pid: process.pid }];
  const control = regularRecord(process.pid, 9, context.configPath);
  const cases = [
    [psReply(71013, [...current, { pid: 42007 }]), lsofReply(control), psReply(71014, [...current, { pid: 42007 }])],
    [psReply(71015, current), lsofReply(control), psReply(71016, [...current, { pid: 42008 }])],
    [psReply(71017, current), lsofReply(control, 71018, 0, 'lsof: incomplete process scan'), psReply(71019, current)],
    [psReply(71020, current), lsofReply(`p${process.pid}\nf9\ntunknown\nnpermission denied\n`), psReply(71021, current)],
    [psReply(71022, current), lsofReply(`p${process.pid}\nf9\nn${context.configPath}\n`), psReply(71023, current)],
  ];
  for (const replies of cases) {
    const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun(replies) });
    assert.equal((await adapter.profileUsage(context)).state, 'unknown');
  }
});

test('Darwin profile usage accepts only explicitly typed unnamed numeric network-policy and Nexus descriptors', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const current = [{ pid: process.pid }];
  const control = regularRecord(process.pid, 9, context.configPath);
  for (const type of ['NPOLICY', 'NEXUS']) {
    const valid = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
      psReply(71032, current), lsofReply(control + `f10\nt${type}\nn\n`), psReply(71033, current),
    ]) });
    assert.deepEqual(await valid.profileUsage(context), { state: 'free', reason: 'profile-usage.no-open-files' }, type);
  }

  // An empty filesystem name, unknown type, missing name field or pseudo-FD is
  // still incomplete evidence; the network-policy exception must not admit it.
  for (const record of ['f10\ntREG\nn\n', 'f10\ntDIR\nn\n', 'f10\ntunknown\nn\n',
    'f10\ntPIPE\nn\n', 'f10\ntNPOLICY\n', 'f10\ntNPOLICY\nn', 'fcwd\ntNPOLICY\nn\n',
    'f10\ntREG\nnpermission denied\n', 'f10\ntNEXUS\n', 'f10\ntNEXUS\nn',
    'fcwd\ntNEXUS\nn\n', 'f10\ntNEXUS_UNKNOWN\nn\n']) {
    const refused = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
      psReply(71034, current), lsofReply(control + record), psReply(71035, current),
    ]) });
    assert.equal((await refused.profileUsage(context)).state, 'unknown', record);
  }
  const missingProcess = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71036, [...current, { pid: 42011 }]), lsofReply(control + 'f10\ntNPOLICY\nn\n'),
    psReply(71037, [...current, { pid: 42011 }]),
  ]) });
  assert.equal((await missingProcess.profileUsage(context)).state, 'unknown');
  const denied = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71040, current), lsofReply(control + 'f10\ntNPOLICY\nn\n', 71999, 0, 'lsof: permission denied'),
  ]) });
  assert.equal((await denied.profileUsage(context)).state, 'unknown');

  const held = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: scriptedProfileRun([
    psReply(71038, [...current, { pid: 42012 }]),
    lsofReply(control + 'f10\ntNPOLICY\nn\nf11\ntNEXUS\nn\n' + regularRecord(42012, 3, context.storePath)),
    psReply(71039, [...current, { pid: 42012 }]),
  ]) });
  assert.deepEqual(await held.profileUsage(context), { state: 'in-use', reason: 'profile-usage.open-file' });
});

test('Darwin profile usage detects a hardlink appearing during the probe', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const alias = path.join(home, 'appearing-store-hardlink');
  const current = [{ pid: process.pid }];
  const replies = [
    psReply(71027, current), lsofReply(regularRecord(process.pid, 9, context.configPath)), psReply(71028, current),
  ];
  let index = 0;
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: async () => {
    if (index === 0) await fs.link(context.storePath, alias);
    return replies[index++];
  } });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'unknown', reason: 'profile-usage.profile-hard-linked' });
  assert.equal((await fs.stat(context.storePath)).nlink, 2);
});

test('Darwin profile usage refuses a non-private control file without changing it or invoking lsof', unixOnly, async t => {
  const { home, context } = await contextFixture(t);
  const original = await fs.readFile(context.configPath);
  await fs.chmod(context.configPath, 0o640);
  let calls = 0;
  const adapter = createDarwinAdapter({ homeDir: home, uid: process.getuid(), env: { PATH: '' }, profileRun: async () => {
    calls++; return { code: 0, stdout: '', stderr: '' };
  } });
  assert.deepEqual(await adapter.profileUsage(context), { state: 'unknown', reason: 'profile-usage.probe-unavailable' });
  assert.equal(calls, 0);
  assert.equal((await fs.stat(context.configPath)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readFile(context.configPath), original);
});
