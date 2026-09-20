#!/usr/bin/env node
/**
 * Deprecated compatibility entrypoint.
 *
 * Invitation material is file-only in the canonical setup CLI so broker
 * credentials are not copied into terminal output or shell history.
 */
console.error("[invite] This legacy command is deprecated and disabled.");
console.error("[invite] Use private files with the canonical setup CLI:");
console.error("node packages/setup/bin/murmur.mjs invite --out ABSOLUTE_FILE --data-dir ABSOLUTE_PROFILE");
console.error("See docs/setup-onboarding.md for the complete invite/reply workflow.");
process.exitCode = 1;
