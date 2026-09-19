import { configureClient } from './clients.js';
import { initialize, invite, join, importPeer } from './onboarding.js';
import { runDoctor } from './doctor.js';
import { parseArgs } from 'node:util';
import { resolveContext } from './paths.js';
import { createLinuxAdapter } from './platform/linux.js';
import { createDarwinAdapter } from './platform/darwin.js';
import { readStatus } from './status.js';
import { setWakeEnabled, markInboxRead, readLogPath } from './commands.js';
import type { PlatformAdapter } from './types.js';

export function platformAdapter(): PlatformAdapter {
  if (process.platform === 'linux') return createLinuxAdapter();
  if (process.platform === 'darwin') return createDarwinAdapter();
  return { manager: 'none',
    async status() { return { state: 'unknown', manager: 'none', pid: null, since: null, lastExitCode: null,
      observedStorePath: null, restartCount: null, restartWindowMs: null, detail: 'service.adapter-unavailable' }; },
    async install() { throw new Error('service.adapter-unavailable'); },
    async start() { throw new Error('service.adapter-unavailable'); },
    async stop() { throw new Error('service.adapter-unavailable'); },
    async detectClients() { return []; },
  };
}
export async function main(args: string[], adapter = platformAdapter()): Promise<unknown> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'agent-id': { type: 'string' }, 'broker-url': { type: 'string' }, 'token-file': { type: 'string' }, 'invite-file': { type: 'string' }, 'reply-file': { type: 'string' }, 'reply-out': { type: 'string' }, out: { type: 'string' },
    client: { type: 'string' }, replace: { type: 'boolean' }, json: { type: 'boolean' }, peer: { type: 'string' }, timeout: { type: 'string' }, 'data-dir': { type: 'string' }, 'service-name': { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) return { commands: ['init --agent-id ID --broker-url URL [--token-file FILE]', 'invite --out FILE', 'join --agent-id ID --invite-file FILE --reply-out FILE', 'add-peer --reply-file FILE', 'status --json', 'doctor --json [--peer AGENT] [--timeout MILLISECONDS]', 'logs path --json', 'service install|start|stop', 'clients detect', 'clients configure --client ID [--replace]', 'wake pause|resume [--apply]', 'inbox mark-read'],
    options: ['--data-dir ABSOLUTE', '--service-name NAME'], note: 'Source checkout build. Native Windows adapter integration pending.' };
  const context = resolveContext({ dataDir: values['data-dir'], serviceName: values['service-name'] });
  const [command, action, extra] = positionals;
  if (extra) throw new Error('cli.unexpected-argument');
  const required = (name: string) => { const value = values[name as keyof typeof values]; if (typeof value !== 'string' || !value) throw new Error('cli.required-option:' + name); return value; };
  if (command === 'init' && !action) return initialize(context, { agentId: required('agent-id'), brokerUrl: required('broker-url'), tokenFile: values['token-file'] });
  if (command === 'invite' && !action) return invite(context, required('out'));
  if (command === 'join' && !action) return join(context, { agentId: required('agent-id'), inviteFile: required('invite-file'), replyOut: required('reply-out') });
  if (command === 'add-peer' && !action) return importPeer(context, required('reply-file'));
  if (command === 'status' && !action) return readStatus({ context, adapter });
  if (command === 'logs' && action === 'path') return readLogPath(context);
  if (command === 'doctor' && !action) return runDoctor({ context, adapter, peer: values.peer, timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) });
  if (command === 'clients' && action === 'configure') return configureClient(context, adapter, required('client'), values.replace);
  if (command === 'clients' && action === 'detect') return { schema: 'murmur.clients/1', clients: await adapter.detectClients(context) };
  if (command === 'wake' && ['pause', 'resume'].includes(action)) return setWakeEnabled(context, adapter, action === 'resume', values.apply);
  if (command === 'inbox' && action === 'mark-read') return markInboxRead(context);
  if (command === 'service' && ['install', 'start', 'stop'].includes(action)) {
    await adapter[action as 'install' | 'start' | 'stop'](context);
    return { schema: 'murmur.service/1', action, service: await adapter.status(context) };
  }
  throw new Error('cli.unknown-command');
}
