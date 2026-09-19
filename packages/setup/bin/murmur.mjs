#!/usr/bin/env node
import { checkRuntime } from '../../../scripts/runtime-capability.mjs';
try { await checkRuntime(); }
catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
// Dynamic imports let the capability check run before the engine imports SQLite.
const { main } = await import('../dist/src/cli.js');
const { safeError } = await import('../dist/src/config.js');
try { process.stdout.write(JSON.stringify(await main(process.argv.slice(2))) + '\n'); }
catch (error) { process.stderr.write(safeError(error) + '\n'); process.exitCode = 1; }
