import { AgentConfigCache } from '../packages/mcp-server/dist/src/agent-config.js';

const key = value => typeof value === 'string' && Buffer.from(value, 'base64').length === 32
  && Buffer.from(value, 'base64').toString('base64') === value;

/** The config file's atomic replacement is the cross-platform reload trigger.
 * Share MCP's owner/path/identity/runtime pinning. Never retain old trust after
 * an unreadable, replaced or malformed configuration; retry on the next read. */
export function createDaemonContacts(configPath, log = () => {}) {
  const cache = new AgentConfigCache(configPath);
  const initial = cache.read();
  const config = { ...initial, peers: {} };
  let applied, failure;
  const refresh = (force = false) => {
    try {
      const next = cache.read(force);
      if (applied === next && !failure) return config.peers;
      for (const [id, peer] of Object.entries(next.peers)) {
        if (!id || !peer || typeof peer.subject !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(peer.subject)
            || !key(peer.encryption?.publicKey) || !key(peer.signing?.publicKey)) throw new Error('agent-config-peer-invalid');
      }
      config.peers = next.peers;
      if (applied || failure) log('info', 'Contacts reloaded', { count: Object.keys(config.peers).length });
      applied = next; failure = undefined;
      return config.peers;
    } catch (error) {
      config.peers = {};
      const reason = /^agent-config-[a-z-]+$/.test(error.message) ? error.message : 'agent-config-unavailable-retry-or-restart';
      if (failure !== reason) log('error', 'Contacts reload failed', { reason });
      failure = reason;
      throw new Error(reason);
    }
  };
  refresh();
  return { config, refresh };
}
