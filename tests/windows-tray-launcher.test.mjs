import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, writeFile, cp, readFile, rm, stat, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const binary = path.join(root, 'spikes/windows-tray-go/murmur-tray.exe');
const fixture = JSON.parse(await readFile(path.join(root, 'contracts/setup/v1/fixtures/status-green.json'), 'utf8'));
const doctorFixture = JSON.parse(await readFile(path.join(root, 'contracts/setup/v1/fixtures/doctor-broker-fail.json'), 'utf8'));
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
const systemPowerShell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  : 'powershell.exe';
let trayIconBytesPromise;

function trayIconBytes() {
  trayIconBytesPromise ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'Murmur dumped icons '));
    try {
      const result = spawnSync(binary, ['--dump-icons', dir], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const bytes = await readFile(path.join(dir, 'green.ico'));
      assert.ok(bytes.length >= 22);
      assert.deepEqual([...bytes.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
      return bytes;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return trayIconBytesPromise;
}

async function copyNativeBundleFiles(dir) {
  await cp(binary, path.join(dir, 'murmur-tray.exe'));
  await writeFile(path.join(dir, 'murmur.ico'), await trayIconBytes());
}

function runPowerShell(command) {
  // Windows PowerShell 5.1 writes stdout in the OEM code page; a localized Desktop such as
  // "Рабочий стол" would come back garbled and name a shortcut path that does not exist.
  return spawnSync(systemPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);${command}`], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
}

function parsePowerShellJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/, '').trim());
}

async function commandTraces(tracePrefix, command) {
  const prefix = `${path.basename(tracePrefix)}.${command}.`;
  const names = (await readdir(path.dirname(tracePrefix))).filter(name => name.startsWith(prefix) && name.endsWith('.json'));
  assert.ok(names.length <= 64, `too many ${command} fixture traces: ${names.length}`);
  const records = [];
  for (const name of names) {
    const recordPath = path.join(path.dirname(tracePrefix), name);
    assert.ok((await stat(recordPath)).size <= 8192, `oversized fixture trace: ${recordPath}`);
    records.push(JSON.parse(await readFile(recordPath, 'utf8')));
  }
  return records;
}

async function waitForCommandTrace(tracePrefix, command) {
  const directory = path.dirname(tracePrefix);
  const prefix = `${path.basename(tracePrefix)}.${command}.`;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (filename && filename.toString().startsWith(prefix)) void check();
    });
    const timer = setTimeout(
      () => finish(new Error(`tray did not invoke ${command} within the bounded fixture deadline`)),
      5000,
    );
    const finish = (error, records) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve(records);
    };
    const check = async () => {
      try {
        const records = await commandTraces(tracePrefix, command);
        if (records.length) finish(undefined, records);
      } catch (error) {
        finish(error);
      }
    };
    watcher.on('error', error => finish(error));
    void check();
  });
}

function userShortcutPaths() {
  const result = runPowerShell(`ConvertTo-Json -Compress -InputObject @(
    [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),'Murmur.lnk'),
    [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),'Murmur.lnk'),
    [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup),'Murmur.lnk'))`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return parsePowerShellJson(result.stdout);
}

function inspectShortcut(shortcutPath) {
  const result = runPowerShell(`$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut(${psLiteral(shortcutPath)});` +
    `[ordered]@{target=$link.TargetPath;arguments=$link.Arguments;workingDirectory=$link.WorkingDirectory;description=$link.Description;icon=$link.IconLocation;windowStyle=$link.WindowStyle}|ConvertTo-Json -Compress`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return parsePowerShellJson(result.stdout);
}

function exactTrayProcesses(executable) {
  const result = runPowerShell(`$target=[IO.Path]::GetFullPath(${psLiteral(executable)});$session=[Diagnostics.Process]::GetCurrentProcess().SessionId;` +
    `$found=@(Get-CimInstance Win32_Process -Filter "Name='murmur-tray.exe'"|Where-Object{$_.ExecutablePath -and [int]$_.SessionId -eq $session -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $target}|Select-Object ProcessId,SessionId,ExecutablePath);` +
    `ConvertTo-Json -Compress -InputObject $found`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return parsePowerShellJson(result.stdout);
}

function processIdentity(processId) {
  const result = runPowerShell(`$process=Get-CimInstance Win32_Process -Filter "ProcessId=${processId}";` +
    `if($null -eq $process){throw 'process not found'};` +
    `[ordered]@{pid=[int]$process.ProcessId;sessionId=[int]$process.SessionId;creationDate=([datetime]$process.CreationDate).ToUniversalTime().ToString('o');executable=[IO.Path]::GetFullPath([string]$process.ExecutablePath)}|ConvertTo-Json -Compress`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return parsePowerShellJson(result.stdout);
}

function waitForMainWindowTitle(processId, title) {
  const result = runPowerShell(`$deadline=[datetime]::UtcNow.AddSeconds(5);do{` +
    `$process=Get-Process -Id ${processId} -ErrorAction SilentlyContinue;if($process){$process.Refresh();` +
    `if($process.MainWindowTitle -ceq ${psLiteral(title)}){Write-Output $process.MainWindowTitle;exit 0}};` +
    `Start-Sleep -Milliseconds 100}while([datetime]::UtcNow -lt $deadline);throw 'guide window was not exposed'`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.replace(/^\uFEFF/, '').trim();
}

// The shape earlier launchers wrote: Windows PowerShell running Open-Murmur.ps1 with the selection.
function writeLegacyShortcut(shortcutPath, launcher, workingDirectory, profile, windowStyle) {
  const quote = value => `"${value}"`;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-NodePath', process.execPath,
    '-DataDir', profile, '-ServiceName', 'ChosenService'].map(quote).join(' ');
  const result = runPowerShell(`$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut(${psLiteral(shortcutPath)});` +
    `$link.TargetPath=${psLiteral(systemPowerShell)};$link.Arguments=${psLiteral(args)};$link.WorkingDirectory=${psLiteral(workingDirectory)};` +
    `$link.Description='Open Murmur controls (managed by Murmur)';$link.IconLocation=${psLiteral(path.join(workingDirectory, 'murmur.ico') + ',0')};` +
    `$link.WindowStyle=${windowStyle};$link.Save()`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function removeOwnedShortcuts(shortcutPaths, trayPath) {
  const command = `$shell=New-Object -ComObject WScript.Shell;foreach($path in @(${shortcutPaths.map(psLiteral).join(',')})){` +
    `if(Test-Path -LiteralPath $path -PathType Leaf){try{$link=$shell.CreateShortcut($path);` +
    `if($link.Description -ceq 'Open Murmur controls (managed by Murmur)' -and ($link.TargetPath -ieq ${psLiteral(trayPath)} -or ` +
    `$link.Arguments.IndexOf(${psLiteral(path.dirname(trayPath))},[StringComparison]::OrdinalIgnoreCase) -ge 0)){Remove-Item -LiteralPath $path -Force}}catch{}}}`;
  const result = runPowerShell(command);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

for (const mode of ['valid', 'null-identity', 'future', 'missing-field', 'normal-return']) {
  test(`Windows launcher invokes real tray and bound CLI: ${mode}`, { skip: process.platform !== 'win32' }, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), "Murmur tray's bundle "));
    let shortcutPaths = [];
    let foreignShortcut = null;
    let launcherPathForCleanup = path.join(dir, 'Open-Murmur.ps1');
    try {
      await cp(path.join(root, 'apps/windows-tray/packaging'), dir, { recursive: true });
      await copyNativeBundleFiles(dir);
      const profile = path.join(dir, "Alice's profile");
      await mkdir(profile);
      const canonicalDir = await realpath(dir);
      const canonicalProfile = await realpath(profile);
      const entry = path.join(dir, 'runtime/packages/setup/bin/murmur.mjs');
      const trace = path.join(dir, 'fixture-trace.json');
      await mkdir(path.dirname(entry), { recursive: true });
      // This is a protocol fixture, not a real service. The native tray must run
      // the selected Node/entry and reject bad identities before opening a GUI.
      const status = structuredClone(fixture);
      if (mode === 'null-identity') status.agentId = null;
      if (mode === 'missing-field') delete status.service;
      const doctor = structuredClone(doctorFixture);
      delete doctor.$stamp;
      delete doctor.$expect;
      await writeFile(entry, `
        import assert from 'node:assert/strict';
        import { writeFileSync, renameSync, statSync } from 'node:fs';
        const args=process.argv.slice(2);
        assert.equal(process.env.NODE_OPTIONS, undefined);
        assert.equal(process.env.MURMUR_STORE_PATH, undefined);
        if(args[0]==='version') console.log(JSON.stringify({schema:'murmur.version/1',version:'2.9.0'}));
        else {
          assert.ok(args[0]==='status'||args[0]==='doctor',args[0]);
          const selected=args[args.indexOf('--data-dir')+1];
          const actual=statSync(selected), expected=statSync(${JSON.stringify(profile)});
          // PowerShell expands the runner's RUNNER~1 parent to runneradmin.
          // Compare the existing directory, not the spelling of that alias.
          assert.equal(actual.dev,expected.dev); assert.equal(actual.ino,expected.ino);
          assert.equal(args[args.indexOf('--service-name')+1],'ChosenService');
          assert.equal(process.env.DATA_DIR,selected);
          const record=JSON.stringify({stage:'validated',command:args[0],args,dataDir:process.env.DATA_DIR,node:process.execPath});
          assert.ok(record.length<=8192,record.length);
          const recordPath=${JSON.stringify(trace)}+'.'+args[0]+'.'+process.pid+'-'+Date.now()+'.json';
          writeFileSync(recordPath+'.tmp',record);renameSync(recordPath+'.tmp',recordPath);
          if(args[0]==='status'){
            const status=${JSON.stringify(status)};
            status.generatedAt=new Date(Date.now()+${mode === 'future' ? 3_600_000 : 0}).toISOString();
            console.log(JSON.stringify(status));
          }else{
            const doctor=${JSON.stringify(doctor)},now=new Date().toISOString();
            doctor.generatedAt=now;for(const stage of doctor.stages)stage.measuredAt=now;
            console.log(JSON.stringify(doctor));
          }
        }
      `);
      const launcher = path.join(canonicalDir, 'Open-Murmur.ps1');
      launcherPathForCleanup = launcher;
      const localAppData = path.join(dir, 'local-app-data');
      if (mode === 'normal-return') {
        await mkdir(localAppData);
        shortcutPaths = userShortcutPaths();
        const occupied = [];
        for (const shortcut of shortcutPaths) {
          if (await stat(shortcut).then(() => true, () => false)) occupied.push(shortcut);
        }
        if (occupied.length) {
          t.skip(`does not modify existing per-user Murmur shortcuts: ${occupied.join(', ')}`);
          return;
        }
      }
      const launchArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
        '-NodePath', process.execPath, '-DataDir', canonicalProfile, '-ServiceName', 'ChosenService', ...(mode === 'normal-return' ? [] : ['-Check'])];
      const launchOptions = {
        timeout: 20_000, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, LOCALAPPDATA: localAppData, NODE_OPTIONS: '--require C:/must-not-run.js', MURMUR_STORE_PATH: 'C:/wrong-store', MURMUR_UPDATE_CHECK: '0' },
      };
      if (mode === 'normal-return') {
        const statePath = path.join(localAppData, 'Murmur/tray-launch-binding.json');
        await mkdir(path.dirname(statePath));
        const live = processIdentity(process.pid);
        const liveBinding = {
          schema: 'murmur.windows-tray-binding/1', pid: live.pid, sessionId: live.sessionId,
          creationDate: live.creationDate, executable: live.executable,
          dataDir: path.join(canonicalDir, 'retired-profile'), serviceName: 'RetiredService', agentId: 'retired-agent',
        };
        const liveBindingBytes = Buffer.from(`${JSON.stringify(liveBinding)}\r\n`, 'utf8');
        await writeFile(statePath, liveBindingBytes);
        const liveRefused = spawnSync('powershell.exe', launchArgs, launchOptions);
        assert.notEqual(liveRefused.status, 0, liveRefused.stdout + liveRefused.stderr);
        assert.match(liveRefused.stdout, /saved launcher belongs to a running Murmur bundle or profile/);
        assert.deepEqual(await readFile(statePath), liveBindingBytes);
        assert.doesNotThrow(() => process.kill(process.pid, 0));
        assert.deepEqual(exactTrayProcesses(path.join(canonicalDir, 'murmur-tray.exe')), []);
        for (const shortcut of shortcutPaths) assert.equal(await stat(shortcut).then(() => true, () => false), false);

        const staleBinding = { ...liveBinding, pid: 2_147_483_647 };
        const staleBindingBytes = Buffer.from(`${JSON.stringify(staleBinding)}\r\n`, 'utf8');
        await writeFile(statePath, staleBindingBytes);
        const oldShortcutBytes = Buffer.from('old shortcut sentinel\r\n', 'utf8');
        await writeFile(shortcutPaths[0], oldShortcutBytes);
        const oldShortcutRefused = spawnSync('powershell.exe', launchArgs, launchOptions);
        assert.notEqual(oldShortcutRefused.status, 0, oldShortcutRefused.stdout + oldShortcutRefused.stderr);
        assert.match(oldShortcutRefused.stdout, /Remove the old shortcut before opening this selection/);
        assert.deepEqual(await readFile(shortcutPaths[0]), oldShortcutBytes);
        assert.deepEqual(await readFile(statePath), staleBindingBytes);
        assert.deepEqual(exactTrayProcesses(path.join(canonicalDir, 'murmur-tray.exe')), []);
        await rm(shortcutPaths[0]);

        // Shortcuts written by earlier launchers ran Windows PowerShell with the launcher. One that
        // names ANOTHER bundle's launcher is foreign and still refuses; this bundle's are migrated.
        const otherLauncher = path.join(canonicalDir, 'other bundle', 'Open-Murmur.ps1');
        writeLegacyShortcut(shortcutPaths[0], otherLauncher, canonicalDir, canonicalProfile, 1);
        const otherLegacyBytes = await readFile(shortcutPaths[0]);
        const otherRefused = spawnSync('powershell.exe', launchArgs, launchOptions);
        assert.notEqual(otherRefused.status, 0, otherRefused.stdout + otherRefused.stderr);
        assert.match(otherRefused.stdout, /Shortcut location is occupied by another target/);
        assert.deepEqual(await readFile(shortcutPaths[0]), otherLegacyBytes);
        assert.deepEqual(exactTrayProcesses(path.join(canonicalDir, 'murmur-tray.exe')), []);
        await rm(shortcutPaths[0]);
        writeLegacyShortcut(shortcutPaths[1], launcher, canonicalDir, canonicalProfile, 1);
        writeLegacyShortcut(shortcutPaths[2], launcher, canonicalDir, canonicalProfile, 7);
      }
      const result = spawnSync('powershell.exe', launchArgs, launchOptions);
      assert.equal(result.error, undefined);
      const statusRecords = await commandTraces(trace, 'status');
      const observed = statusRecords.find(record => record.stage === 'validated');
      assert.ok(observed, JSON.stringify(statusRecords));
      assert.equal(observed.args[0], 'status', JSON.stringify(observed));
      assert.equal(observed.stage, 'validated', JSON.stringify(observed));
      if (mode === 'normal-return') {
        assert.equal(result.status, 0, result.stdout + result.stderr + JSON.stringify(observed));
        assert.match(result.stdout, /Murmur opened/);
        assert.equal(result.stdout.match(/Updated the Murmur shortcut to open the tray directly/g)?.length, 2, result.stdout);
        const statePath = path.join(localAppData, 'Murmur/tray-launch-binding.json');
        const stateText = await readFile(statePath, 'utf8');
        const state = JSON.parse(stateText);
        assert.equal(state.schema, 'murmur.windows-tray-binding/1');
        assert.equal(state.executable.toLowerCase(), path.join(canonicalDir, 'murmur-tray.exe').toLowerCase());
        assert.equal(state.dataDir.toLowerCase(), canonicalProfile.toLowerCase());
        assert.equal(state.serviceName, 'ChosenService');
        assert.equal(state.agentId, fixture.agentId);
        assert.ok(Number.isSafeInteger(state.pid) && state.pid > 0);
        assert.ok(!Number.isNaN(Date.parse(state.creationDate)));

        for (const shortcut of shortcutPaths) {
          const link = inspectShortcut(shortcut);
          // The shortcut starts the tray itself, without a PowerShell window or arguments; the tray
          // finds the profile and service from the binding the launcher just recorded.
          assert.equal(link.target.toLowerCase(), path.join(canonicalDir, 'murmur-tray.exe').toLowerCase());
          assert.equal(link.workingDirectory.toLowerCase(), canonicalDir.toLowerCase());
          assert.equal(link.description, 'Open Murmur controls (managed by Murmur)');
          assert.equal(link.icon.replace(/,\s*0$/, ',0').toLowerCase(), `${path.join(canonicalDir, 'murmur.ico')},0`.toLowerCase());
          assert.equal(link.arguments, '');
          assert.equal(link.windowStyle, 1, shortcut);
        }

        assert.equal(waitForMainWindowTitle(state.pid, 'Murmur'), 'Murmur');
        const reopened = spawnSync('powershell.exe', launchArgs, launchOptions);
        assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
        assert.match(reopened.stdout, /Murmur controls opened/);
        assert.equal(waitForMainWindowTitle(state.pid, 'Murmur'), 'Murmur');
        const doctorRecords = await waitForCommandTrace(trace, 'doctor');
        assert.ok(doctorRecords.some(record => record.stage === 'validated' && record.command === 'doctor'), JSON.stringify(doctorRecords));
        const processesAfterReopen = exactTrayProcesses(path.join(canonicalDir, 'murmur-tray.exe'));
        assert.deepEqual(processesAfterReopen.map(value => value.ProcessId), [state.pid]);

        const checkArgs = [...launchArgs, '-Check'];
        const stateBeforeCheck = await readFile(statePath);
        const malformedState = Buffer.from('{"schema":"foreign"}\r\n', 'utf8');
        await writeFile(statePath, malformedState);
        const checked = spawnSync('powershell.exe', checkArgs, launchOptions);
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        assert.deepEqual(await readFile(statePath), malformedState);
        for (const shortcut of shortcutPaths) assert.equal((await stat(shortcut)).isFile(), true);
        const malformedRefused = spawnSync('powershell.exe', launchArgs, launchOptions);
        assert.notEqual(malformedRefused.status, 0, malformedRefused.stdout + malformedRefused.stderr);
        assert.match(malformedRefused.stdout, /saved tray launch binding has an unknown shape/);
        assert.deepEqual(await readFile(statePath), malformedState);
        assert.deepEqual(exactTrayProcesses(path.join(canonicalDir, 'murmur-tray.exe')).map(value => value.ProcessId), [state.pid]);
        await writeFile(statePath, stateBeforeCheck);

        foreignShortcut = shortcutPaths[1];
        await rm(foreignShortcut, { force: true });
        const foreignBytes = Buffer.from('foreign shortcut sentinel\r\n', 'utf8');
        await writeFile(foreignShortcut, foreignBytes);
        const refused = spawnSync('powershell.exe', launchArgs, launchOptions);
        assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
        assert.match(refused.stdout, /Shortcut location is occupied/);
        assert.deepEqual(await readFile(foreignShortcut), foreignBytes);
        assert.deepEqual(await readFile(statePath), stateBeforeCheck);
        const processesAfterRefusal = exactTrayProcesses(path.join(canonicalDir, 'murmur-tray.exe'));
        assert.deepEqual(processesAfterRefusal.map(value => value.ProcessId), [state.pid]);

        // Installed by setup.exe: the installer owns the shortcuts, so the launcher changes none of
        // them — a missing one is not created, a foreign one does not block opening.
        await rm(shortcutPaths[0]);
        const before = await Promise.all(shortcutPaths.map(shortcut => readFile(shortcut).catch(() => null)));
        await writeFile(path.join(canonicalDir, 'murmur-install.json'), '{"schema":"murmur.windows-install/1"}\r\n');
        const installedOpen = spawnSync('powershell.exe', launchArgs, launchOptions);
        assert.equal(installedOpen.status, 0, installedOpen.stdout + installedOpen.stderr);
        assert.match(installedOpen.stdout, /Murmur controls opened/);
        assert.deepEqual(await Promise.all(shortcutPaths.map(shortcut => readFile(shortcut).catch(() => null))), before);
        assert.equal(before[0], null);
        assert.deepEqual(exactTrayProcesses(path.join(canonicalDir, 'murmur-tray.exe')).map(value => value.ProcessId), [state.pid]);
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
      if (foreignShortcut) await rm(foreignShortcut, { force: true });
      if (shortcutPaths.length) removeOwnedShortcuts(shortcutPaths, path.join(path.dirname(launcherPathForCleanup), 'murmur-tray.exe'));
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('Windows launcher gives actionable guidance when Node is missing', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'Murmur missing Node '));
  try {
    await cp(path.join(root, 'apps/windows-tray/packaging'), dir, { recursive: true });
    await copyNativeBundleFiles(dir);
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
    await copyNativeBundleFiles(dir);
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
    await copyNativeBundleFiles(dir);
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

test('Without a profile named, the launcher opens the tray instead of a folder dialog', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'Murmur no profile named '));
  const tray = path.join(dir, 'murmur-tray.exe');
  const stopTray = () => { for (const found of exactTrayProcesses(tray)) { try { process.kill(found.ProcessId); } catch {} } };
  try {
    await cp(path.join(root, 'apps/windows-tray/packaging'), dir, { recursive: true });
    await copyNativeBundleFiles(dir);
    await mkdir(path.join(dir, 'runtime/packages/setup/bin'), { recursive: true });
    await writeFile(path.join(dir, 'runtime/packages/setup/bin/murmur.mjs'), '// not reached');
    const env = { ...process.env, LOCALAPPDATA: path.join(dir, 'local'), MURMUR_UPDATE_CHECK: '0' };
    // A dialog would block until the timeout; the launcher must return at once and leave one tray running.
    const launched = spawnSync(systemPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(dir, 'Open-Murmur.ps1'), '-NodePath', process.execPath], { timeout: 20_000, encoding: 'utf8', windowsHide: true, env });
    assert.equal(launched.error, undefined, String(launched.error));
    assert.equal(launched.status, 0, launched.stdout + launched.stderr);
    for (let i = 0; i < 50 && exactTrayProcesses(tray).length === 0; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(exactTrayProcesses(tray).length, 1);
    // A second open does not start another tray.
    assert.equal(spawnSync(systemPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(dir, 'Open-Murmur.ps1'), '-NodePath', process.execPath], { timeout: 20_000, encoding: 'utf8', windowsHide: true, env }).status, 0);
    assert.equal(exactTrayProcesses(tray).length, 1);
    stopTray();
    // The .cmd without arguments starts the tray itself, without PowerShell.
    const cmd = spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/c', path.join(dir, 'Open-Murmur.cmd')], { timeout: 20_000, encoding: 'utf8', windowsHide: true, env });
    assert.equal(cmd.status, 0, cmd.stdout + cmd.stderr);
    for (let i = 0; i < 50 && exactTrayProcesses(tray).length === 0; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(exactTrayProcesses(tray).length, 1);
  } finally {
    stopTray();
    await new Promise(r => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true });
  }
});

// Migration is staged like creation: the old shortcut is replaced only while it still has the bytes
// that were recognized, and a later failure puts those bytes back instead of deleting the shortcut.
test('A migrated launcher shortcut is replaced only as recognized and rolls back to its old bytes', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'Murmur migration Мой '));
  try {
    const shortcut = path.join(dir, 'Murmur.lnk');
    const tray = path.join(dir, 'murmur-tray.exe');
    await writeFile(tray, '');
    writeLegacyShortcut(shortcut, path.join(dir, 'Open-Murmur.ps1'), dir, path.join(dir, 'profile'), 7);
    const oldBytes = await readFile(shortcut);
    const launcher = path.join(root, 'apps/windows-tray/packaging/Open-Murmur.ps1');
    const result = runPowerShell(`$ErrorActionPreference='Stop';$ast=[Management.Automation.Language.Parser]::ParseFile(${psLiteral(launcher)},[ref]$null,[ref]$null);` +
      `foreach($name in 'Test-LinkedItem','Install-MissingShortcuts','Test-ExactCreatedShortcut','Remove-CreatedShortcuts'){` +
      `$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true);. ([scriptblock]::Create($definition.Extent.Text))};` +
      `function Initialize-TrayActivationApi {};$path=${psLiteral(shortcut)};$old=[Convert]::ToBase64String([IO.File]::ReadAllBytes($path));` +
      `$entry=@{Path=$path;Exists=$false;OldBytes=$old;Target=${psLiteral(tray)};Arguments='';WorkingDirectory=${psLiteral(dir)};Description='Open Murmur controls (managed by Murmur)';Icon=${psLiteral(path.join(dir, 'murmur.ico') + ',0')};WindowStyle=1};` +
      `$stale=$entry.Clone();$stale.OldBytes=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('something else'));` +
      `try{$null=Install-MissingShortcuts @($stale);$staleError=''}catch{$staleError=$_.Exception.Message};` +
      `$afterStale=[Convert]::ToBase64String([IO.File]::ReadAllBytes($path));` +
      `$created=@(Install-MissingShortcuts @($entry));$link=(New-Object -ComObject WScript.Shell).CreateShortcut($path);$migrated=[ordered]@{target=$link.TargetPath;arguments=$link.Arguments;windowStyle=$link.WindowStyle};` +
      `Remove-CreatedShortcuts $created;` +
      `[ordered]@{staleError=$staleError;untouchedAfterStale=($afterStale -ceq $old);migrated=$migrated;restored=([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq $old);` +
      `leftovers=@(Get-ChildItem -LiteralPath ${psLiteral(dir)} -Filter '.murmur-*' -Force).Count}|ConvertTo-Json -Compress`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const outcome = parsePowerShellJson(result.stdout);
    assert.match(outcome.staleError, /The old Murmur shortcut changed before it could be updated/);
    assert.equal(outcome.untouchedAfterStale, true);
    assert.equal(outcome.migrated.target.toLowerCase(), tray.toLowerCase());
    assert.equal(outcome.migrated.arguments, '');
    assert.equal(outcome.migrated.windowStyle, 1);
    assert.equal(outcome.restored, true);
    assert.equal(outcome.leftovers, 0);
    assert.deepEqual(await readFile(shortcut), oldBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
