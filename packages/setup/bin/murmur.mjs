#!/usr/bin/env node
import { checkRuntime } from '../../../scripts/runtime-capability.mjs';
try { await checkRuntime(); }
catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
// Dynamic imports let the capability check run before the engine imports SQLite.
const { main, isRawCliOutput } = await import('../dist/src/cli.js');
const { safeError } = await import('../dist/src/config.js');
const lineMode = process.argv[2] === 'status' && process.argv.includes('--line');
try {
  const result = await main(process.argv.slice(2));
  if (isRawCliOutput(result)) {
    if (result.text) process.stdout.write(result.text + '\n');
  } else process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  if (lineMode) process.stdout.write('Murmur: unknown (status.command-failed)\n');
  process.stderr.write(safeError(error) + '\n');
  process.exitCode = 1;
}
