#!/usr/bin/env node
import { checkRuntime } from './runtime-capability.mjs';

try {
  await checkRuntime();
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
