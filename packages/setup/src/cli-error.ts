import { safeError } from './config.js';

/** Human stderr only; structured consumers retain the stable error code. */
export function cliErrorText(error: unknown): string {
  const code = safeError(error);
  if (code === 'migration.profile-hard-linked') {
    return code + '\nA profile file has another hard-link name. Migration stopped; your files were kept. '
      + 'Inspect files with multiple links in the selected profile, then locate their other names on the same volume. '
      + 'After verifying and removing only an unintended link, retry migration. Renaming a file does not separate the links. '
      + 'Read-only inspection steps: https://github.com/alexfrmn/murmur/blob/main/docs/setup-onboarding.md#files-with-more-than-one-name';
  }
  if (code === 'migration.profile-usage-unavailable') {
    return code + '\nMurmur could not inspect every process that might be using this profile. '
      + 'Migration stopped; your files were kept. Closing the tray icon does not stop the service or client integrations. '
      + 'This build cannot force migration when profile use is unknown. '
      + 'Details: https://github.com/alexfrmn/murmur/blob/main/docs/setup-onboarding.md#migrating-an-existing-broker';
  }
  return code;
}
