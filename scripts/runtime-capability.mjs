import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node;
const minimumPolicy = /^>=(\d+\.\d+\.\d+)$/.exec(policy ?? '');
if (!minimumPolicy) throw new Error('runtime.node-policy-invalid: engines.node must declare one minimum Node.js version.');
export const MIN_NODE_VERSION = minimumPolicy[1];

function failure(code, detail) {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

// Only built-ins and the root policy manifest: no installed workspace modules or
// profile access before the CLI loads modules that statically import node:sqlite.
export async function checkRuntime({ version = process.versions.node, loadSqlite = () => import('node:sqlite') } = {}) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const current = match?.slice(1).map(Number);
  const minimum = MIN_NODE_VERSION.split('.').map(Number);
  const difference = current?.findIndex((value, index) => value !== minimum[index]);
  if (!current || (difference >= 0 && current[difference] < minimum[difference])) {
    throw failure('runtime.node-version-unsupported', `Use Node.js ${MIN_NODE_VERSION} or newer; current version is ${version}.`);
  }
  try {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(':memory:');
    try {
      if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('probe failed');
    } finally {
      db.close();
    }
  } catch {
    // Do not expose loader output or an arbitrary error payload in diagnostics.
    throw failure('runtime.sqlite-unavailable', `Node.js ${MIN_NODE_VERSION} or newer with working node:sqlite is required; current version is ${version}. Remove --no-experimental-sqlite or choose a compatible Node.js installation.`);
  }
}
