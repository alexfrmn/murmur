#!/usr/bin/env node
import { main } from '../dist/src/cli.js';
import { safeError } from '../dist/src/config.js';
try { process.stdout.write(JSON.stringify(await main(process.argv.slice(2))) + '\n'); }
catch (error) { process.stderr.write(safeError(error) + '\n'); process.exitCode = 1; }
