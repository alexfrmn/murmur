import { runDoctor } from './doctor.js';
import { parseArgs } from 'node:util';
import { resolveContext } from './paths.js';
import { createLinuxAdapter } from './platform/linux.js';
import { createDarwinAdapter } from './platform/darwin.js';
import { readStatus } from './status.js';
import { setWakeEnabled, markInboxRead } from './commands.js';
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
    json: { type: 'boolean' }, peer: { type: 'string' }, timeout: { type: 'string' }, 'data-dir': { type: 'string' }, 'service-name': { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) return { commands: ['status --json', 'doctor --json [--peer AGENT] [--timeout MILLISECONDS]', 'service install|start|stop', 'clients detect', 'wake pause|resume [--apply]', 'inbox mark-read'],
    options: ['--data-dir ABSOLUTE', '--service-name NAME'], note: 'Source checkout build. Native Windows adapter integration pending.' };
  const context = resolveContext({ dataDir: values['data-dir'], serviceName: values['service-name'] });
  const [command, action, extra] = positionals;
  if (extra) throw new Error('cli.unexpected-argument');
  if (command === 'status' && !action) return readStatus({ context, adapter });
  if (command === 'doctor' && !action) return runDoctor({ context, adapter, peer: values.peer, timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) });
  if (command === 'clients' && action === 'detect') return { schema: 'murmur.clients/1', clients: await adapter.detectClients(context) };
  if (command === 'wake' && ['pause', 'resume'].includes(action)) return setWakeEnabled(context, adapter, action === 'resume', values.apply);
  if (command === 'inbox' && action === 'mark-read') return markInboxRead(context);
  if (command === 'service' && ['install', 'start', 'stop'].includes(action)) {
    await adapter[action as 'install' | 'start' | 'stop'](context);
    return { schema: 'murmur.service/1', action, service: await adapter.status(context) };
  }
  throw new Error('cli.unknown-command');
}
