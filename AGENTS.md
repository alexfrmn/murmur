# Working on Murmur

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the affected package documentation before changing code. Keep fixes in a focused branch or worktree from current `main`; do not overwrite unrelated work. Commit only the intended files. Merge after the designated reviewer approves the exact head and its required checks pass. A changed head needs a new review of the change, including conflict resolution. Preserve both intended sides of a conflict.

## Shared behavior

- `packages/setup` owns onboarding, selected profile paths, service/client configuration and update checks. Desktop and terminal integrations consume its CLI contracts; do not add independent profile discovery, version comparison or configuration writers.
- `package.json` `engines.node` owns the runtime minimum. Use the shared capability check before loading the engine; keep stated requirements covered by `scripts/check-node-requirements.mjs`.
- `contracts/setup/v1/fixtures` is the shared setup contract corpus. JavaScript, Swift and Go read the same files. Change a frozen contract deliberately across consumers; do not silently rename codes or copy fixtures into another implementation.
- Preserve the difference between configured and observed state, transport delivery and agent wake, and unknown and healthy. A successful command response does not by itself prove a running daemon or a returned reply.
- User-facing integrations default to English and retain Russian as an explicit choice. Keep protocol codes, command arguments and paths stable; translate presentation through the integration's localization resources.

## Safety and ownership

- Use disposable profiles and isolated local brokers for tests. Never restart a shared broker, mutate an existing user's identity or client settings, or deploy to production without authorization for that action.
- Validate paths, profile identity and resource ownership before mutation. Test refusal by inspecting unchanged state, not just an exit code. Do not overwrite an occupied output or install over a service you do not own.
- Never print or commit private profile configuration, invite credentials, tokens or real message contents. Fixtures use generated disposable keys and synthetic messages. Review tracked files and release contents, including accidentally added binaries and backups.
- Preserve existing user settings, especially custom status lines. Optional integrations must be explicit and reversible. Reading an inbox and marking it read are different operations.
- Unsigned release assets require clear first-open instructions. Opening a verified release-page destination does not verify the downloaded binary. Do not install updates silently.

## Verification and evidence

Use the checks relevant to the changed behavior, then the required CI jobs. Typical source checks are `npm ci`, `npm run build`, `npm run typecheck`, and `npm run test:unit`; see the workflows for native platform and runtime-archive checks.

- Diagnose failures from a reproduction before changing timeouts or adding retries. Add a regression for the failed behavior, including ordering where relevant.
- Read which CI steps actually executed. A missing module, skipped test or unrelated green job is not evidence for the changed component.
- Native service, launcher, clipboard and desktop changes require scoped native acceptance. Download/first-open claims require the actual downloaded artifact with its platform security metadata intact. Do not infer them from a cross-build.
- Bind reports to full source commits, artifact hashes, runtime versions and the exact commands/environment. Separate real network/UI observations from injected fixtures. Record skips and unverified behavior, including login/reboot and elapsed timers.
- Clean up only the test resources you created, after checking their identity. Keep secret-free proof outside the repository unless it is a useful reproducible test.

## Releases

Build from a clean committed source and the tracked runtime recipe/lockfile. Verify the payload manifest and archive hash after transfer/extraction. Rebuild after source or version changes; do not move acceptance evidence to a different artifact or overwrite an old release version. Publishing a release, sending invitations and deploying a site are separate actions from preparing or reviewing a PR.
