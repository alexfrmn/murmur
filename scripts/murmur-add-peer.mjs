#!/usr/bin/env node
/**
 * Deprecated compatibility entrypoint.
 *
 * Reply material is file-only in the canonical setup CLI so it is not copied
 * into command arguments or shell history.
 */
console.error("[add-peer] This legacy command is deprecated and disabled.");
console.error("[add-peer] Use private files with the canonical setup CLI:");
console.error("node packages/setup/bin/murmur.mjs add-peer --reply-file ABSOLUTE_FILE --data-dir ABSOLUTE_PROFILE");
console.error("See docs/setup-onboarding.md for the complete invite/reply workflow.");
process.exitCode = 1;
