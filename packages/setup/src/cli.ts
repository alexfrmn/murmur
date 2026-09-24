import { configureClient, previewClientConfiguration } from './clients.js';
import { prepareReplyTest, checkReplyTest } from './reply-test.js';
import { listOutboxAttention, setOutboxDismissed } from './outbox-attention.js';
import { dismissWake } from './wake-attention.js';
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

export async function main(args: string[], adapter = platformAdapter(), input: AsyncIterable<Uint8Array | string> = process.stdin): Promise<unknown> {
  // `murmur --version` is the first thing people type after npm install; answer it like `murmur version`.
  if (args.some(a => a === '--version' || a === '-v') && args.every(a => ['--version', '-v', '--json'].includes(a))) return readVersion();
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      'msg-id': { type: 'string' }, 'expected-state': { type: 'string' }, 'expected-agent': { type: 'string' },
      'agent-id': { type: 'string' }, 'broker-url': { type: 'string' }, broker: { type: 'string' }, 'token-file': { type: 'string' }, 'invite-file': { type: 'string' }, 'reply-file': { type: 'string' }, 'reply-out': { type: 'string' }, out: { type: 'string' },
      'invite-stdin': { type: 'boolean' }, 'reply-stdin': { type: 'boolean' },
      client: { type: 'string' }, replace: { type: 'boolean' }, 'plan-id': { type: 'string' }, 'test-token': { type: 'string' }, json: { type: 'boolean' }, line: { type: 'boolean' }, limit: { type: 'string' }, peer: { type: 'string' }, timeout: { type: 'string' }, 'data-dir': { type: 'string' }, 'service-name': { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
    } });
  } catch (error) {
    // parseArgs explains itself in a sentence, which safeError must hide; keep a stable code instead.
    throw new Error((error as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'cli.unknown-option' : 'cli.invalid-arguments');
  }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) return { commands: ['version --json', 'updates check|enable|disable --json', 'init --agent-id ID --broker-url URL [--token-file FILE]', 'invite [--out FILE] [--broker PUBLIC_URL] [--json]', 'join --agent-id ID (--invite-stdin|--invite-file FILE) [--reply-out FILE] [--json]', 'add-peer (--reply-stdin|--reply-file FILE)', 'status --json|--line', 'doctor --json [--peer AGENT] [--timeout MILLISECONDS]', 'logs path --json', 'service install|start|stop|uninstall', 'clients detect', 'clients preview --client ID', 'clients configure --client ID [--replace] [--plan-id SHA256]', 'reply-test prepare --peer AGENT', 'reply-test check --test-token TOKEN', 'wake pause|resume [--apply]', 'wake dismiss --msg-id ID --expected-agent ID', 'inbox read [--limit 1..100]', 'inbox mark-read', 'outbox list --json', 'outbox dismiss|restore --msg-id ID --expected-state TOKEN --expected-agent ID', 'mcp serve --data-dir ABSOLUTE'],
    options: ['--data-dir ABSOLUTE', '--service-name NAME'], note: 'Windows service mutations require an elevated terminal and the matching native helper.' };
  const [command, action, extra] = positionals;
  if (extra) throw new Error('cli.unexpected-argument');
  if (values.line && command !== 'status') throw new Error('cli.line-only-for-status');
  if (values.line && values.json) throw new Error('cli.output-mode-conflict');
  if (command === 'version' && !action) return readVersion();
  if (command === 'updates' && action === 'check') return checkUpdates();
  if (command === 'updates' && ['enable', 'disable'].includes(action)) return setUpdateChecks(action === 'enable');
  const context = resolveContext({ dataDir: values['data-dir'], serviceName: values['service-name'] });
  const required = (name: string) => { const value = values[name as keyof typeof values]; if (typeof value !== 'string' || !value) throw new Error('cli.required-option:' + name); return value; };
  if (command === 'init' && !action) return initialize(context, { agentId: required('agent-id'), brokerUrl: required('broker-url'), tokenFile: values['token-file'] });
  const onboardingInput = async (kind: 'invite' | 'reply') => {
    if (values[`${kind}-file`] !== undefined && values[`${kind}-stdin`]) throw new Error('onboarding.input-conflict');
    if (!values[`${kind}-stdin`]) {
      if (!values[`${kind}-file`]) throw new Error('onboarding.input-required');
      return undefined;
    }
    if (input === process.stdin && process.stdin.isTTY) throw new Error('onboarding.stdin-required');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 16384) throw new Error('onboarding.input-too-large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  if (command === 'invite' && !action) return invite(context, values.out, { brokerUrl: values.broker });
  if (command === 'join' && !action) return join(context, { agentId: required('agent-id'), inviteFile: values['invite-file'],
    invitation: await onboardingInput('invite'), replyOut: values['reply-out'] });
  if (command === 'add-peer' && !action) return importPeer(context, values['reply-file'], await onboardingInput('reply'));
  if (command === 'status' && !action) {
    const status = await readStatus({ context, adapter });
    return values.line ? rawCliOutput(renderStatusLine(status)) : status;
  }
  if (command === 'outbox' && action === 'list') return listOutboxAttention(context);
  if (command === 'outbox' && ['dismiss', 'restore'].includes(action)) return setOutboxDismissed(context,
    required('msg-id'), required('expected-state'), required('expected-agent'), action === 'dismiss');
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
    if (process.platform === 'win32') {
      if (!adapter.logDirectory) throw new Error('logs.windows-native-location-unavailable');
      return readLogPath(context, adapter);
    }
    return readLogPath(context);
  }
  if (command === 'doctor' && !action) return runDoctor({ context, adapter, peer: values.peer, timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) });
  if (command === 'clients' && action === 'preview') return previewClientConfiguration(context, adapter, required('client'));
  if (command === 'clients' && action === 'configure') return configureClient(context, adapter, required('client'), values.replace, values['plan-id']);
  if (command === 'clients' && action === 'detect') return { schema: 'murmur.clients/1', clients: await adapter.detectClients(context) };
  if (command === 'reply-test' && action === 'prepare') return prepareReplyTest(context, required('peer'));
  if (command === 'reply-test' && action === 'check') return checkReplyTest(context, required('test-token'));
  if (command === 'wake' && ['pause', 'resume'].includes(action)) return setWakeEnabled(context, adapter, action === 'resume', values.apply);
  if (command === 'wake' && action === 'dismiss') return dismissWake(context, required('msg-id'), required('expected-agent'));
  if (command === 'inbox' && action === 'read') return readInbox(context, values.limit === undefined ? 20 : Number(values.limit));
  if (command === 'inbox' && action === 'mark-read') return markInboxRead(context);
  if (command === 'service' && ['install', 'start', 'stop', 'uninstall'].includes(action)) {
    if ((await readStatus({ context, adapter })).service.state === 'running-unmanaged') throw new Error('service.running-unmanaged');
    const operation = adapter[action as 'install' | 'start' | 'stop' | 'uninstall'];
    if (!operation) throw new Error('service.uninstall-unavailable');
    await operation.call(adapter, context);
    return { schema: 'murmur.service/1', action, service: await adapter.status(context) };
  }
  throw new Error('cli.unknown-command');
}
