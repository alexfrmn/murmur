#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { MIN_NODE_VERSION } from './runtime-capability.mjs';

// Active installation instructions, not historical release notes. Optional
// Windows/site documents join this check when their independent PRs are merged.
const documents = [
  ['README.md', true],
  ['docs/wake-native.md', true],
  ['site/index.html', false],
  ['spikes/windows-onboarding/Install-Murmur.ps1', false],
];
const errors = [];
for (const [file, required] of documents) {
  let text;
  try { text = readFileSync(new URL('../' + file, import.meta.url), 'utf8'); }
  catch (error) { if (!required && error.code === 'ENOENT') continue; throw error; }
  const versions = [
    ...text.matchAll(/Node(?:\.js)?(?:\s+with\s+`node:sqlite`)?[\s(]*(\d+(?:\.\d+){0,2})(?:\+|\s+или\s+новее|\s+or\s+(?:later|newer))/gi),
    ...text.matchAll(/badge\/node-%3E%3D(\d+(?:\.\d+){0,2})-/gi),
  ].map(match => match[1]);
  if (versions.length === 0) errors.push(`${file}: no explicit Node.js minimum found`);
  for (const version of new Set(versions)) {
    if (version !== MIN_NODE_VERSION) errors.push(`${file}: Node.js ${version} disagrees with engines.node >=${MIN_NODE_VERSION}`);
  }
}
if (errors.length) {
  process.stderr.write(errors.join('\n') + '\n');
  process.exitCode = 1;
}
