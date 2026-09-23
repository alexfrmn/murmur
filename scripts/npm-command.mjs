// Run npm through Node, including on Windows where npm.cmd cannot be passed to
// execFile directly. No shell interpolation of registry URLs or paths is used.
import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function npmCommand(env = process.env) {
  const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'npm'), path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
  }
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const file = realpathSync(candidate);
    if (path.basename(file) === 'npm-cli.js') return [process.execPath, file];
  }
  throw new Error('Cannot locate npm-cli.js; run through npm or add the Node/npm installation to PATH');
}
export function runNpm(args, options = {}) {
  const [command, ...prefix] = npmCommand(options.env);
  return execFileSync(command, [...prefix, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
