import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, readFile, rm } from 'node:fs/promises';
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
        import { writeFileSync } from 'node:fs';
        const args=process.argv.slice(2);
        writeFileSync(${JSON.stringify(trace)},JSON.stringify({args,dataDir:process.env.DATA_DIR,node:process.execPath}));
        assert.equal(process.env.NODE_OPTIONS, undefined);
        assert.equal(process.env.MURMUR_STORE_PATH, undefined);
        if(args[0]==='version') console.log(JSON.stringify({schema:'murmur.version/1',version:'2.9.0'}));
        else {
          assert.equal(args[0],'status');
          assert.equal(args[args.indexOf('--data-dir')+1],${JSON.stringify(profile)});
          assert.equal(args[args.indexOf('--service-name')+1],'ChosenService');
          assert.equal(process.env.DATA_DIR,${JSON.stringify(profile)});
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
        const cleanup = spawnSync('powershell.exe', ['-NoProfile', '-Command',
          'Get-CimInstance Win32_Process -Filter "Name=\'murmur-tray.exe\'" | Where-Object { $_.ExecutablePath -eq $env:MURMUR_TEST_EXECUTABLE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], {
          env: { ...process.env, MURMUR_TEST_EXECUTABLE: path.join(dir, 'murmur-tray.exe') }, encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(cleanup.status, 0, cleanup.stderr);
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
