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
  if (!['--settings', '--data-dir', '--murmur-bin'].includes(name) || process.argv[i + 1] === undefined) throw new Error('arguments-invalid');
  values[name] = process.argv[++i];
}
if (!dryRun) throw new Error('dry-run-required');
const absolute = (name) => {
  const value = values[name];
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name.slice(2)}-invalid`);
  return value;
};
const settingsPath = absolute('--settings'), dataDir = absolute('--data-dir'), murmurBin = absolute('--murmur-bin');
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
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.mjs');
const quote = process.platform === 'win32'
  ? value => `"${value.replaceAll('"', '""')}"`
  : value => `'${value.replaceAll("'", "'\\''")}'`;
const args = [process.execPath, script, '--data-dir', dataDir, '--murmur-bin', murmurBin];
if (current) args.push('--existing-command-base64', Buffer.from(current.command).toString('base64'));
const proposedStatusLine = { ...(current ?? {}), type: 'command', command: args.map(quote).join(' '),
  refreshInterval: current?.refreshInterval ?? 5 };
process.stdout.write(JSON.stringify({ schema: 'murmur.claude-statusline-dry-run/1', settingsPath,
  writesPerformed: false, preservedExistingCommand: Boolean(current), proposedStatusLine }, null, 2) + '\n');
