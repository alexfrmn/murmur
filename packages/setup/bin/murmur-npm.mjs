#!/usr/bin/env node
// The npm payload keeps the same root-relative layout as release archives.
// Source checkouts and native bundles continue to use the ordinary CLI entry.
import { existsSync } from 'node:fs';
const packed = new URL('../runtime/packages/setup/bin/murmur.mjs', import.meta.url);
await import(existsSync(packed) ? packed.href : './murmur.mjs');
