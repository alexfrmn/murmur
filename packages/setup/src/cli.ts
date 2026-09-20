import { configureClient } from './clients.js';
import { initialize, invite, join, importPeer } from './onboarding.js';
import { runDoctor } from './doctor.js';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { resolveContext } from './paths.js';
import { createLinuxAdapter } from './platform/linux.js';
import { createWindowsAdapter } from './platform/windows.js';
import { createDarwinAdapter } from './platform/darwin.js';
import { readStatus } from './status.js';
import { setWakeEnabled, markInboxRead, readInbox, readLogPath } from './commands.js';
import { renderStatusLine } from './status-line.js';
import type { PlatformAdapter } from './types.js';
import { readVersion, checkUpdates, setUpdateChecks } from './updates.js';
import { migrateBroker } from './broker-migration.js';

export function platformAdapter(): PlatformAdapter {
  if (process.platform === 'linux') return createLinuxAdapter();
  if (process.platform === 'darwin') return createDarwinAdapter();
  if (process.platform === 'win32') return createWindowsAdapter();
  return { manager: 'none',
    async status() { return { state: 'unknown', manager: 'none', pid: null, since: null, lastExitCode: null,
      observedStorePath: null, restartCount: null, restartWindowMs: null, detail: 'service.adapter-unavailable' }; },
    async install() { throw new Error('service.adapter-unavailable'); },
    async start() { throw new Error('service.adapter-unavailable'); },
    async stop() { throw new Error('service.adapter-unavailable'); },
    async detectClients() { return []; },
  };
}

export interface RawCliOutput { kind: 'raw'; text: string }
export const rawCliOutput = (text: string): RawCliOutput => ({ kind: 'raw', text });
export const isRawCliOutput = (value: unknown): value is RawCliOutput => !!value && typeof value === 'object'
  && (value as RawCliOutput).kind === 'raw' && typeof (value as RawCliOutput).text === 'string';

export async function main(args: string[], adapter = platformAdapter()): Promise<unknown> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'agent-id': { type: 'string' }, 'broker-url': { type: 'string' }, 'token-file': { type: 'string' }, 'user-file': { type: 'string' }, 'password-file': { type: 'string' }, 'ca-file': { type: 'string' }, 'server-name': { type: 'string' }, 'invite-file': { type: 'string' }, 'reply-file': { type: 'string' }, 'reply-out': { type: 'string' }, out: { type: 'string' },
    client: { type: 'string' }, replace: { type: 'boolean' }, json: { type: 'boolean' }, line: { type: 'boolean' }, limit: { type: 'string' }, peer: { type: 'string' }, timeout: { type: 'string' }, 'data-dir': { type: 'string' }, 'service-name': { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) return { commands: ['version --json', 'updates check|enable|disable --json', 'init --agent-id ID --broker-url URL [private broker file options]', 'invite --out FILE', 'join --agent-id ID --invite-file FILE --reply-out FILE [private broker file options]', 'add-peer --reply-file FILE', 'broker migrate --broker-url URL [private broker file options] [--apply]', 'status --json|--line', 'doctor --json [--peer AGENT] [--timeout MILLISECONDS]', 'logs path --json', 'service install|start|stop|uninstall', 'clients detect', 'clients configure --client ID [--replace]', 'wake pause|resume [--apply]', 'inbox read [--limit 1..100]', 'inbox mark-read', 'mcp serve --data-dir ABSOLUTE'],
    brokerFileOptions: ['--token-file ABSOLUTE', '--user-file ABSOLUTE --password-file ABSOLUTE', '--ca-file ABSOLUTE', '--server-name DNS'],
    options: ['--data-dir ABSOLUTE', '--service-name NAME'], note: 'Windows service mutations require an elevated terminal and the matching native helper.' };
  const [command, action, extra] = positionals;
  if (extra) throw new Error('cli.unexpected-argument');
  if (values.line && command !== 'status') throw new Error('cli.line-only-for-status');
  if (values.line && values.json) throw new Error('cli.output-mode-conflict');
  const brokerOptionNames = ['token-file','user-file','password-file','ca-file','server-name'] as const;
  const hasBrokerOptions = brokerOptionNames.some(name => values[name] !== undefined);
  const acceptsBrokerOptions = (command === 'init' && !action) || (command === 'join' && !action) || (command === 'broker' && action === 'migrate');
  if (hasBrokerOptions && !acceptsBrokerOptions) throw new Error('cli.option-not-supported');
  if (values['broker-url'] !== undefined && !((command === 'init' && !action) || (command === 'broker' && action === 'migrate'))) throw new Error('cli.option-not-supported');
  if (command === 'version' && !action) return readVersion();
  if (command === 'updates' && action === 'check') return checkUpdates();
  if (command === 'updates' && ['enable', 'disable'].includes(action)) return setUpdateChecks(action === 'enable');
  const context = resolveContext({ dataDir: values['data-dir'], serviceName: values['service-name'] });
  const required = (name: string) => { const value = values[name as keyof typeof values]; if (typeof value !== 'string' || !value) throw new Error('cli.required-option:' + name); return value; };
  const brokerFiles = { tokenFile: values['token-file'], userFile: values['user-file'], passwordFile: values['password-file'], caFile: values['ca-file'], serverName: values['server-name'] };
  if (command === 'init' && !action) return initialize(context, { agentId: required('agent-id'), brokerUrl: required('broker-url'), ...brokerFiles });
  if (command === 'invite' && !action) return invite(context, required('out'));
  if (command === 'join' && !action) return join(context, { agentId: required('agent-id'), inviteFile: required('invite-file'), replyOut: required('reply-out'), ...brokerFiles });
  if (command === 'broker' && action === 'migrate') return migrateBroker(context, adapter, { brokerUrl: required('broker-url'), ...brokerFiles, apply: values.apply });
  if (command === 'add-peer' && !action) return importPeer(context, required('reply-file'));
  if (command === 'status' && !action) {
    const status = await readStatus({ context, adapter });
    return values.line ? rawCliOutput(renderStatusLine(status)) : status;
  }
  if (command === 'mcp' && action === 'serve') {
    if (values['data-dir'] === undefined) throw new Error('cli.required-option:data-dir');
    process.env.DATA_DIR = context.dataDir;
    process.env.MURMUR_DATA_DIR = context.dataDir;
    process.env.MURMUR_STORE_PATH = context.storePath;
    process.env.MURMUR_CHANNEL_ROSTER_PATH = path.join(context.dataDir, 'channel-roster.db');
    await import('@murmurv2/mcp-server');
    return rawCliOutput('');
  }
  if (command === 'logs' && action === 'path') {
    if (process.platform === 'win32') throw new Error('logs.windows-native-location-unavailable');
    return readLogPath(context);
  }
  if (command === 'doctor' && !action) return runDoctor({ context, adapter, peer: values.peer, timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) });
  if (command === 'clients' && action === 'configure') return configureClient(context, adapter, required('client'), values.replace);
  if (command === 'clients' && action === 'detect') return { schema: 'murmur.clients/1', clients: await adapter.detectClients(context) };
  if (command === 'wake' && ['pause', 'resume'].includes(action)) return setWakeEnabled(context, adapter, action === 'resume', values.apply);
  if (command === 'inbox' && action === 'read') return readInbox(context, values.limit === undefined ? 20 : Number(values.limit));
  if (command === 'inbox' && action === 'mark-read') return markInboxRead(context);
  if (command === 'service' && ['install', 'start', 'stop', 'uninstall'].includes(action)) {
    const operation = adapter[action as 'install' | 'start' | 'stop' | 'uninstall'];
    if (!operation) throw new Error('service.uninstall-unavailable');
    await operation.call(adapter, context);
    return { schema: 'murmur.service/1', action, service: await adapter.status(context) };
  }
  throw new Error('cli.unknown-command');
}
