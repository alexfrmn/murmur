#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_INPUT = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1];
  if (!['--data-dir', '--murmur-bin', '--existing-command-base64'].includes(name) || value === undefined) {
    process.stderr.write('usage: statusline.mjs --data-dir ABSOLUTE --murmur-bin ABSOLUTE [--existing-command-base64 BASE64]\n');
    process.exit(2);
  }
  options[name] = value;
}
const absolute = (name) => {
  const value = options[name];
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name.slice(2)}-invalid`);
  }
  return value;
};
const dataDir = absolute('--data-dir');
const murmurBin = absolute('--murmur-bin');
let existingCommand = null;
if (options['--existing-command-base64'] !== undefined) {
  const encoded = options['--existing-command-base64'];
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 90_000) throw new Error('existing-command-invalid');
  existingCommand = Buffer.from(encoded, 'base64').toString('utf8');
  if (!existingCommand || existingCommand.length > 65_536 || existingCommand.includes('\0')) throw new Error('existing-command-invalid');
}

let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  if (input.length > MAX_INPUT) throw new Error('statusline-input-too-large');
}

function run(file, args, { shell = false, stdin = Buffer.alloc(0), timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0, settled = false, timer;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) chunks.push(chunk);
      else child.kill();
    });
    child.on('error', () => finish({ ok: false, stdout: '' }));
    child.on('close', code => finish({ ok: code === 0 && size <= MAX_OUTPUT, stdout: Buffer.concat(chunks).toString('utf8') }));
    timer = setTimeout(() => { child.kill(); finish({ ok: false, stdout: '' }); }, timeout);
    child.stdin.end(stdin);
  });
}

async function existing() {
  if (existingCommand === null) return '';
  if (process.platform === 'win32') {
    const result = await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', existingCommand], { stdin: input, timeout: 5_000 });
    return result.ok ? result.stdout.trimEnd() : 'Existing status line unavailable';
  }
  const result = await run('/bin/sh', ['-lc', existingCommand], { stdin: input, timeout: 5_000 });
  return result.ok ? result.stdout.trimEnd() : 'Existing status line unavailable';
}
const cleanMurmur = (value) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 256);

const [prior, murmur] = await Promise.all([
  existing(),
  run(murmurBin, ['status', '--line', '--data-dir', dataDir]).then(result => result.ok
    ? cleanMurmur(result.stdout)
    : 'Murmur: unknown (status.command-failed)'),
]);
if (prior && murmur) process.stdout.write(`${prior}\n${murmur}\n`);
else if (prior || murmur) process.stdout.write(`${prior || murmur}\n`);
