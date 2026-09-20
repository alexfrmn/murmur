import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('../spikes/windows-onboarding/Install-Murmur.ps1', import.meta.url));
const windows = process.platform === 'win32';
function fixture(scenario) {
  const dir = mkdtempSync(path.join(tmpdir(), 'murmur installer '));
  const runtime = path.join(dir, 'runtime'), profile = path.join(dir, 'private profile');
  mkdirSync(path.join(runtime, 'packages/setup/bin'), { recursive: true });
  mkdirSync(path.join(runtime, 'bin')); writeFileSync(path.join(runtime, 'bin/murmur-svc.exe'), 'not executed');
  // Real PowerShell + Node, bounded stand-in for engine responses. Product tests
  // exercise the native helper separately; this verifies installer orchestration.
  writeFileSync(path.join(runtime, 'packages/setup/bin/murmur.mjs'), `
    import fs from 'node:fs';
    const args=process.argv.slice(2), stateFile=${JSON.stringify(path.join(dir, 'calls.json'))};
    const calls=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):[];
    calls.push({args,env:{DATA_DIR:process.env.DATA_DIR,MURMUR_DATA_DIR:process.env.MURMUR_DATA_DIR,NODE_OPTIONS:process.env.NODE_OPTIONS,MURMUR_STORE_PATH:process.env.MURMUR_STORE_PATH}});
    fs.writeFileSync(stateFile,JSON.stringify(calls));
    const scenario=${JSON.stringify(scenario)}, installed=calls.some(c=>c.args[0]==='service');
    if(args[0]==='version') console.log(JSON.stringify({schema:'murmur.version/1'}));
    else if(args[0]==='status') console.log(JSON.stringify({schema:'murmur.status/1',agentId:scenario==='wrong-agent'?'someone-else':'fixture',service:{manager:'windows-service',state:installed?'running':'stopped',pid:installed?100:null,observedStorePath:installed&&scenario!=='no-store'?${JSON.stringify(path.join(profile, 'murmur.db'))}:null}}));
    else if(args[0]==='service') console.log(JSON.stringify({schema:'murmur.service/1',action:scenario==='wrong-action'?'stop':'install'}));
    else process.exit(20);
  `);
  return { dir, profile, run: () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-AgentId', 'fixture', '-RuntimeRoot', runtime, '-DataDir', profile, '-NodePath', process.execPath,
    '-ServiceName', 'MurmurInstallerFixture' + process.pid], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, NODE_OPTIONS: '--require Z:\\never-execute.js', MURMUR_STORE_PATH: 'Z:\\wrong.db' } }),
    calls: () => JSON.parse(readFileSync(path.join(dir, 'calls.json'), 'utf8')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
for (const scenario of ['ok', 'wrong-agent', 'wrong-action', 'no-store']) test(`PowerShell installer ${scenario}`, { skip: !windows }, () => {
  const f = fixture(scenario);
  try {
    const result = f.run();
    assert.equal(result.status, scenario === 'ok' ? 0 : 1, result.stdout + result.stderr);
    const calls = f.calls();
    assert.ok(calls.every(c => c.args[0] !== 'init'), 'installer must not initialize keys before native checks');
    assert.equal(calls.filter(c => c.args[0] === 'service').length, scenario === 'wrong-agent' ? 0 : 1);
    for (const c of calls) {
      // GetFullPath expands Windows 8.3 aliases; compare the existing parent's
      // identity and missing leaf, not two spellings of the same path.
      assert.equal(path.basename(c.env.DATA_DIR), path.basename(f.profile));
      const actual = statSync(path.dirname(c.env.DATA_DIR)), expected = statSync(path.dirname(f.profile));
      assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino);
      assert.equal(c.env.MURMUR_DATA_DIR, c.env.DATA_DIR);
      assert.equal(c.args[c.args.indexOf('--data-dir') + 1], c.env.DATA_DIR);
      assert.equal(c.env.NODE_OPTIONS, undefined); assert.equal(c.env.MURMUR_STORE_PATH, undefined);
    }
    assert.equal(existsSync(f.profile), false, 'stand-in engine never creates a profile; installer must not either');
    if (scenario === 'ok') assert.deepEqual(calls.map(c => c.args.slice(0, 2)), [['version', '--data-dir'], ['status', '--data-dir'], ['service', 'install'], ['status', '--data-dir']]);
  } finally { f.cleanup(); }
});

test('PowerShell installer gives actionable guidance when Node is missing', { skip: !windows }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'murmur installer missing Node '));
  try {
    const runtime = path.join(dir, 'runtime'), profile = path.join(dir, 'profile');
    mkdirSync(path.join(runtime, 'packages/setup/bin'), { recursive: true });
    mkdirSync(path.join(runtime, 'bin'));
    writeFileSync(path.join(runtime, 'packages/setup/bin/murmur.mjs'), '// not reached');
    writeFileSync(path.join(runtime, 'bin/murmur-svc.exe'), 'not reached');
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
    const command = `$env:PATH=${psLiteral(dir)}; & ${psLiteral(installer)} -AgentId fixture -RuntimeRoot ${psLiteral(runtime)} -DataDir ${psLiteral(profile)}`;
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, TEMP: dir, TMP: dir, LOCALAPPDATA: dir },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Install Node\.js 22\.13\.0 or newer/);
    assert.doesNotMatch(result.stdout, /Get-Command/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
