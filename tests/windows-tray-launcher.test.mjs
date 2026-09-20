import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const binary = path.join(root, 'spikes/windows-tray-go/murmur-tray.exe');
const fixture = JSON.parse(await readFile(path.join(root, 'contracts/setup/v1/fixtures/status-green.json'), 'utf8'));
for (const mode of ['valid', 'null-identity', 'future', 'missing-field', 'normal-return']) {
  test(`Windows launcher invokes real tray and bound CLI: ${mode}`, { skip: process.platform !== 'win32' }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "Murmur tray's bundle "));
    try {
      await cp(path.join(root, 'apps/windows-tray/packaging'), dir, { recursive: true });
      await cp(binary, path.join(dir, 'murmur-tray.exe'));
      const profile = path.join(dir, "Alice's profile");
      await mkdir(profile);
      const entry = path.join(dir, 'runtime/packages/setup/bin/murmur.mjs');
      const trace = path.join(dir, 'fixture-trace.json');
      await mkdir(path.dirname(entry), { recursive: true });
      // This is a protocol fixture, not a real service. The native tray must run
      // the selected Node/entry and reject bad identities before opening a GUI.
      const status = structuredClone(fixture);
      if (mode === 'null-identity') status.agentId = null;
      if (mode === 'missing-field') delete status.service;
      await writeFile(entry, `
        import assert from 'node:assert/strict';
        import { writeFileSync, statSync } from 'node:fs';
        const args=process.argv.slice(2);
        writeFileSync(${JSON.stringify(trace)},JSON.stringify({args,dataDir:process.env.DATA_DIR,node:process.execPath}));
        assert.equal(process.env.NODE_OPTIONS, undefined);
        assert.equal(process.env.MURMUR_STORE_PATH, undefined);
        if(args[0]==='version') console.log(JSON.stringify({schema:'murmur.version/1',version:'2.9.0'}));
        else {
          assert.equal(args[0],'status');
          const selected=args[args.indexOf('--data-dir')+1];
          const actual=statSync(selected), expected=statSync(${JSON.stringify(profile)});
          // PowerShell expands the runner's RUNNER~1 parent to runneradmin.
          // Compare the existing directory, not the spelling of that alias.
          assert.equal(actual.dev,expected.dev); assert.equal(actual.ino,expected.ino);
          assert.equal(args[args.indexOf('--service-name')+1],'ChosenService');
          assert.equal(process.env.DATA_DIR,selected);
          writeFileSync(${JSON.stringify(trace)},JSON.stringify({stage:'validated',args,dataDir:process.env.DATA_DIR}));
          const status=${JSON.stringify(status)};
          status.generatedAt=new Date(Date.now()+${mode === 'future' ? 3_600_000 : 0}).toISOString();
          console.log(JSON.stringify(status));
        }
      `);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'Open-Murmur.ps1'),
        '-NodePath', process.execPath, '-DataDir', profile, '-ServiceName', 'ChosenService', ...(mode === 'normal-return' ? [] : ['-Check'])], {
        timeout: 20_000, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '--require C:/must-not-run.js', MURMUR_STORE_PATH: 'C:/wrong-store' },
      });
      assert.equal(result.error, undefined);
      const observed = JSON.parse(await readFile(trace, 'utf8'));
      assert.equal(observed.args[0], 'status', JSON.stringify(observed));
      assert.equal(observed.stage, 'validated', JSON.stringify(observed));
      if (mode === 'normal-return') {
        assert.equal(result.status, 0, result.stdout + result.stderr + JSON.stringify(observed));
        assert.match(result.stdout, /Murmur opened/);
      } else if (mode === 'valid') {
        assert.equal(result.status, 0, result.stdout + result.stderr + JSON.stringify(observed));
        const output = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
        assert.equal(output.agentId, fixture.agentId);
        assert.equal(output.probe.schema, 'murmur.tray-probe/1');
      } else assert.notEqual(result.status, 0, 'invalid profile must refuse before GUI');
    } finally {
      if (mode === 'normal-return') {
        // Only the executable created by this test may be stopped.
        const listed = spawnSync('powershell.exe', ['-NoProfile', '-Command',
          'ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "Name=\'murmur-tray.exe\'" | Select-Object ProcessId,ExecutablePath)'], {
          encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(listed.status, 0, listed.stderr);
        const expected = await stat(path.join(dir, 'murmur-tray.exe'));
        for (const process of JSON.parse(listed.stdout)) {
          if (!process.ExecutablePath) continue;
          const actual = await stat(process.ExecutablePath).catch(() => null);
          if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) continue;
          assert.ok(Number.isSafeInteger(process.ProcessId) && process.ProcessId > 0);
          const cleanup = spawnSync('powershell.exe', ['-NoProfile', '-Command',
            `$p=Get-Process -Id ${process.ProcessId} -ErrorAction SilentlyContinue; if($p){$p.Kill();$p.WaitForExit()}`], {
            encoding: 'utf8', timeout: 10_000,
          });
          assert.equal(cleanup.status, 0, cleanup.stderr);
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('Windows launcher gives actionable guidance when Node is missing', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'Murmur missing Node '));
  try {
    await cp(path.join(root, 'apps/windows-tray/packaging'), dir, { recursive: true });
    await cp(binary, path.join(dir, 'murmur-tray.exe'));
    await mkdir(path.join(dir, 'runtime/packages/setup/bin'), { recursive: true });
    await writeFile(path.join(dir, 'runtime/packages/setup/bin/murmur.mjs'), '// not reached');
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
    const command = `$env:PATH=${psLiteral(dir)}; & ${psLiteral(path.join(dir, 'Open-Murmur.ps1'))} -DataDir ${psLiteral(dir)} -Check`;
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      timeout: 20_000, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TEMP: dir, TMP: dir, LOCALAPPDATA: dir },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Install Node\.js 22\.13\.0 or newer/);
    assert.doesNotMatch(result.stdout, /Get-Command/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows launcher persists an explicit Russian tray locale', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'Murmur Russian locale '));
  try {
    await cp(path.join(root, 'apps/windows-tray/packaging'), dir, { recursive: true });
    await cp(binary, path.join(dir, 'murmur-tray.exe'));
    const profile = path.join(dir, 'profile'), localAppData = path.join(dir, 'local-app-data');
    const entry = path.join(dir, 'runtime/packages/setup/bin/murmur.mjs');
    await mkdir(profile);
    await mkdir(path.dirname(entry), { recursive: true });
    const status = structuredClone(fixture);
    await writeFile(entry, `
      const args=process.argv.slice(2);
      if(args[0]==='version') console.log(JSON.stringify({schema:'murmur.version/1',version:'2.9.0'}));
      else { const status=${JSON.stringify(status)}; status.generatedAt=new Date().toISOString(); console.log(JSON.stringify(status)); }
    `);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'Open-Murmur.ps1'),
      '-NodePath', process.execPath, '-DataDir', profile, '-Language', 'ru', '-Check'], {
      timeout: 20_000, encoding: 'utf8', windowsHide: true, env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const preference = JSON.parse(await readFile(path.join(localAppData, 'Murmur/tray-preferences.json'), 'utf8'));
    assert.deepEqual(preference, { schema: 'murmur.tray-preferences/1', locale: 'ru' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows launcher does not overwrite locale while rejecting a profile', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'Murmur invalid profile locale '));
  try {
    await cp(path.join(root, 'apps/windows-tray/packaging'), dir, { recursive: true });
    await cp(binary, path.join(dir, 'murmur-tray.exe'));
    const profile = path.join(dir, 'profile'), localAppData = path.join(dir, 'local-app-data');
    const entry = path.join(dir, 'runtime/packages/setup/bin/murmur.mjs');
    const preferencePath = path.join(localAppData, 'Murmur/tray-preferences.json');
    await mkdir(profile);
    await mkdir(path.dirname(entry), { recursive: true });
    await mkdir(path.dirname(preferencePath), { recursive: true });
    await writeFile(preferencePath, JSON.stringify({ schema: 'murmur.tray-preferences/1', locale: 'ru' }));
    const status = structuredClone(fixture);
    status.agentId = null;
    await writeFile(entry, `
      const args=process.argv.slice(2);
      if(args[0]==='version') console.log(JSON.stringify({schema:'murmur.version/1',version:'2.9.0'}));
      else { const status=${JSON.stringify(status)}; status.generatedAt=new Date().toISOString(); console.log(JSON.stringify(status)); }
    `);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'Open-Murmur.ps1'),
      '-NodePath', process.execPath, '-DataDir', profile, '-Check'], {
      timeout: 20_000, encoding: 'utf8', windowsHide: true, env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const preference = JSON.parse(await readFile(preferencePath, 'utf8'));
    assert.deepEqual(preference, { schema: 'murmur.tray-preferences/1', locale: 'ru' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
