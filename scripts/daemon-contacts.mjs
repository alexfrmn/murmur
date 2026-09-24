import { AgentConfigCache } from '../packages/mcp-server/dist/src/agent-config.js';
import { isDeepStrictEqual } from 'node:util';

const key = value => typeof value === 'string' && Buffer.from(value, 'base64').length === 32
  && Buffer.from(value, 'base64').toString('base64') === value;
const contactId = value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/** The config file's atomic replacement is the cross-platform reload trigger.
 * Share MCP's owner/path/identity/runtime pinning. Failed reads cannot introduce
 * new trust: keep the last valid Contacts available and report the failure. */
export function createDaemonContacts(configPath, log = () => {}) {
  const cache = new AgentConfigCache(configPath);
  const initial = cache.read();
  const config = { ...initial, peers: {} };
  let applied, failure, invalidSignature = '[]';
  let diagnostic = { state: 'current', count: 0, invalidCount: 0,
    lastSuccessAt: null, lastError: null, lastErrorAt: null };
  const refresh = (force = false) => {
    try {
      const next = cache.read(force);
      if (applied === next && !failure) return config.peers;
      const invalid = [];
      const peers = Object.fromEntries(Object.entries(next.peers).filter(([id, peer]) => {
        if (contactId(id) && peer && typeof peer.subject === 'string' && /^[A-Za-z0-9_.:-]+$/.test(peer.subject)
            && key(peer.encryption?.publicKey) && key(peer.signing?.publicKey)) return true;
        invalid.push(contactId(id) ? id : null);
        return false;
      }));
      const signature = JSON.stringify(invalid.sort());
      const changed = !isDeepStrictEqual(config.peers, peers);
      config.peers = peers;
      const at = new Date().toISOString();
      diagnostic = { state: invalid.length ? 'partial' : 'current', count: Object.keys(peers).length,
        invalidCount: invalid.length, lastSuccessAt: at,
        lastError: invalid.length ? 'agent-config-peer-invalid' : null,
        lastErrorAt: invalid.length ? signature !== invalidSignature || failure ? at : diagnostic.lastErrorAt : null };
      if (invalid.length && (signature !== invalidSignature || failure))
        log('warn', 'Invalid Contacts skipped', { reason: 'agent-config-peer-invalid', contacts: invalid, count: invalid.length });
      // MCP may change ctime by protecting the same file. Compare content, not
      // cache object identity, before claiming that Contacts changed.
      if ((applied && changed) || failure) log('info', 'Contacts reloaded', { count: diagnostic.count });
      invalidSignature = signature;
      applied = next; failure = undefined;
      return config.peers;
    } catch (error) {
      const reason = /^agent-config-[a-z-]+$/.test(error?.message) ? error.message : 'agent-config-unavailable-retry-or-restart';
      if (failure !== reason) log('error', 'Contacts reload failed', { reason });
      diagnostic = { ...diagnostic, state: 'retained', lastError: reason,
        lastErrorAt: failure === reason ? diagnostic.lastErrorAt : new Date().toISOString() };
      failure = reason;
      return config.peers;
    }
  };
  refresh();
  return { config, refresh, diagnostics: () => ({ ...diagnostic }) };
}
