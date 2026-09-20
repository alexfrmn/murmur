#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const values = {};
let dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (name === '--dry-run') { dryRun = true; continue; }
  if (!['--settings', '--data-dir', '--node-bin', '--murmur-entrypoint', '--existing-shell'].includes(name)
    || process.argv[i + 1] === undefined) throw new Error('arguments-invalid');
  values[name] = process.argv[++i];
}
if (!dryRun) throw new Error('dry-run-required');
const absolute = (name) => {
  const value = values[name];
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name.slice(2)}-invalid`);
  return value;
};
const settingsPath = absolute('--settings'), dataDir = absolute('--data-dir');
const nodeBin = absolute('--node-bin'), murmurEntrypoint = absolute('--murmur-entrypoint');
let settings = {};
try {
  const handle = await fs.open(settingsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new Error('settings-file-invalid');
    settings = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings-invalid');
const current = settings.statusLine;
if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current)
  || current.type !== 'command' || typeof current.command !== 'string' || !current.command)) throw new Error('statusline-not-composable');
if (current?.refreshInterval !== undefined
  && (!Number.isInteger(current.refreshInterval) || current.refreshInterval < 1)) throw new Error('statusline-refresh-interval-invalid');
const requestedShell = values['--existing-shell'];
if (requestedShell !== undefined && !['bash', 'powershell'].includes(requestedShell)) throw new Error('existing-shell-invalid');
if (process.platform === 'win32' && current && requestedShell === undefined) throw new Error('existing-shell-required-on-windows');
if (process.platform !== 'win32' && requestedShell !== undefined) throw new Error('existing-shell-windows-only');
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.mjs');
const wrapperArgs = ['--data-dir', dataDir, '--murmur-node', nodeBin, '--murmur-entrypoint', murmurEntrypoint];
if (current) {
  wrapperArgs.push('--existing-command-base64', Buffer.from(current.command).toString('base64'));
  wrapperArgs.push('--existing-shell', process.platform === 'win32' ? requestedShell : 'posix');
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
let command;
if (process.platform === 'win32') {
  const forward = value => value.replaceAll('\\', '/');
  const encodedConfig = Buffer.from(JSON.stringify({ node: forward(nodeBin), script: forward(script),
    args: wrapperArgs.map(forward) })).toString('base64');
  const powershell = `$j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedConfig}'))|ConvertFrom-Json;`
    + '$a=@($j.args);& $j.node $j.script @a;exit $LASTEXITCODE';
  command = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powershell, 'utf16le').toString('base64')}`;
} else command = [nodeBin, script, ...wrapperArgs].map(quote).join(' ');
const proposedStatusLine = { ...(current ?? {}), type: 'command', command,
  refreshInterval: current?.refreshInterval ?? 5 };
process.stdout.write(JSON.stringify({ schema: 'murmur.claude-statusline-dry-run/1', settingsPath,
  writesPerformed: false, preservedExistingCommand: Boolean(current), proposedStatusLine }, null, 2) + '\n');
