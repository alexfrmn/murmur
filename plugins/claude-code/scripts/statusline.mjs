#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_INPUT = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const INPUT_TIMEOUT = 2_000;
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1];
  if (!['--data-dir', '--murmur-node', '--murmur-entrypoint', '--existing-command-base64', '--existing-shell', '--existing-shell-path'].includes(name)
    || value === undefined) {
    process.stderr.write('usage: statusline.mjs --data-dir ABSOLUTE --murmur-node ABSOLUTE --murmur-entrypoint ABSOLUTE [--existing-command-base64 BASE64 --existing-shell posix|bash|powershell --existing-shell-path ABSOLUTE]\n');
    process.exit(2);
  }
  options[name] = value;
}
const canonicalAbsolute = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) return null;
  const localSeparators = process.platform === 'win32' ? value.replaceAll('/', '\\') : value;
  const normalized = path.normalize(localSeparators);
  return normalized === localSeparators ? normalized : null;
};
const absolute = (name) => {
  const value = options[name];
  const canonical = canonicalAbsolute(value);
  if (canonical === null) throw new Error(`${name.slice(2)}-invalid`);
  return canonical;
};
const dataDir = absolute('--data-dir');
const murmurNode = absolute('--murmur-node');
const murmurEntrypoint = absolute('--murmur-entrypoint');
let existingCommand = null;
if (options['--existing-command-base64'] !== undefined) {
  const encoded = options['--existing-command-base64'];
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 90_000) throw new Error('existing-command-invalid');
  existingCommand = Buffer.from(encoded, 'base64').toString('utf8');
  if (!existingCommand || existingCommand.length > 65_536 || existingCommand.includes('\0')) throw new Error('existing-command-invalid');
}
const existingShell = options['--existing-shell'] ?? (process.platform === 'win32' ? null : 'posix');
const existingShellPath = options['--existing-shell-path'] === undefined ? null : absolute('--existing-shell-path');
if (existingCommand === null && options['--existing-shell'] !== undefined) throw new Error('existing-shell-without-command');
if (existingCommand === null && existingShellPath !== null) throw new Error('existing-shell-path-without-command');
if (existingCommand !== null && !['posix', 'bash', 'powershell'].includes(existingShell)) throw new Error('existing-shell-required');
if (process.platform === 'win32' && existingCommand !== null && !['bash', 'powershell'].includes(existingShell)) {
  throw new Error('existing-shell-required-on-windows');
}
if (existingShell === 'bash' && existingShellPath === null) {
  throw new Error('bash-shell-path-required');
}

function readInput() {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0, done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      if (!ok) process.stdin.destroy();
      resolve({ ok, input: ok ? Buffer.concat(chunks) : Buffer.alloc(0) });
    };
    const onData = chunk => {
      const value = Buffer.from(chunk);
      size += value.length;
      if (size > MAX_INPUT) finish(false);
      else chunks.push(value);
    };
    const onEnd = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), INPUT_TIMEOUT);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const signalGroup = (pid, signal) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const waitForGroupExit = async (pid, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!signalGroup(pid, 0)) return true;
    await delay(20);
  }
  return !signalGroup(pid, 0);
};
const killWindowsTree = child => new Promise(resolve => {
  if (!child.pid) { child.kill('SIGKILL'); resolve(); return; }
  const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    shell: false, windowsHide: true, stdio: 'ignore',
  });
  let done = false;
  const finish = (fallback) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (fallback) child.kill('SIGKILL');
    resolve();
  };
  const timer = setTimeout(() => { killer.kill(); finish(true); }, 1_000);
  killer.on('error', () => finish(true));
  killer.on('close', code => finish(code !== 0));
});

const activeRuns = new Set();
let cancelling = false;
const cancelAll = exitCode => {
  if (cancelling) return;
  cancelling = true;
  for (const control of activeRuns) control.stop();
  const force = setTimeout(() => {
    for (const control of activeRuns) control.force();
  }, 300);
  const exit = setTimeout(() => process.exit(exitCode), 1_500);
  Promise.allSettled([...activeRuns].map(control => control.closed)).then(() => {
    clearTimeout(force); clearTimeout(exit); process.exit(exitCode);
  });
};
process.on('SIGTERM', () => cancelAll(143));
process.on('SIGINT', () => cancelAll(130));

function run(file, args, { stdin = Buffer.alloc(0), timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    const child = spawn(file, args, { shell: false, detached: posix, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0, settled = false, stopping = false, forcedFailure = false, spawnFailed = false, timer, escalation;
    let closeControl;
    const closed = new Promise(done => { closeControl = done; });
    const force = () => {
      forcedFailure = true;
      if (!posix) { void killWindowsTree(child); return; }
      try { signalGroup(child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const stop = () => {
      if (settled) return;
      forcedFailure = true;
      if (stopping) return;
      stopping = true;
      if (!posix) { void killWindowsTree(child); return; }
      try { signalGroup(child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      escalation = setTimeout(force, 250);
    };
    const control = { stop, force, closed };
    activeRuns.add(control);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation);
      activeRuns.delete(control); closeControl(); resolve(result);
    };
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) chunks.push(chunk);
      else stop();
    });
    child.on('error', () => { spawnFailed = true; forcedFailure = true; });
    child.on('close', async code => {
      clearTimeout(timer); clearTimeout(escalation);
      if (posix && child.pid) {
        try {
          if (signalGroup(child.pid, 0)) signalGroup(child.pid, 'SIGKILL');
          if (!await waitForGroupExit(child.pid)) forcedFailure = true;
        } catch { forcedFailure = true; }
      }
      finish({ ok: !spawnFailed && !forcedFailure && code === 0 && size <= MAX_OUTPUT,
        stdout: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.on('error', error => {
      if (!['EPIPE', 'ECONNRESET'].includes(error.code)) stop();
    });
    timer = setTimeout(stop, timeout);
    try { child.stdin.end(stdin); } catch (error) {
      if (!['EPIPE', 'ECONNRESET'].includes(error.code)) stop();
    }
  });
}

async function existing(inputState) {
  if (existingCommand === null) return '';
  if (!inputState.ok) return 'Existing status line unavailable';
  const invocation = existingShell === 'posix'
    ? [existingShellPath ?? '/bin/sh', ['-lc', existingCommand]]
    : existingShell === 'bash'
      ? [existingShellPath, ['-lc', existingCommand]]
      : [existingShellPath ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', existingCommand]];
  const result = await run(invocation[0], invocation[1], { stdin: inputState.input, timeout: 5_000 });
  return result.ok ? result.stdout.trimEnd() : 'Existing status line unavailable';
}
const cleanMurmur = (value) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 256);

const inputState = await readInput();
const [prior, murmur] = await Promise.all([
  existing(inputState),
  run(murmurNode, [murmurEntrypoint, 'status', '--line', '--data-dir', dataDir]).then(result => result.ok
    ? cleanMurmur(result.stdout)
    : 'Murmur: unknown (status.command-failed)'),
]);
if (prior && murmur) process.stdout.write(`${prior}\n${murmur}\n`);
else if (prior || murmur) process.stdout.write(`${prior || murmur}\n`);
