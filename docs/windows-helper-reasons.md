# Windows service failure reasons

When `murmur service install|start|stop|uninstall` or `murmur status` fails on
Windows, the CLI prints one code. If the native helper `murmur-svc.exe` named the
cause, the code is `service.helper.<key>`; otherwise it is
`service.helper-command-failed` (an older helper, or a failure without a reason).

The helper ends a failure with one last stderr line `murmur-svc: reason=<key>`.
The CLI keeps only that key and never shows the rest of the helper output, which
can contain paths. That text is not saved anywhere. For failures after the
service has run, the service and daemon logs under
`%ProgramData%\Murmur\logs\<service name>\` may hold more evidence when they
exist; failures before that (access, creation, early checks) leave none. Keys are
case-sensitive and do not depend on the helper language.

Before these codes, check the two common causes that have their own codes:
`service.elevation-required` (open PowerShell with **Run as administrator**) and
`profile.virtualized-appdata` (choose a profile outside `AppData`, for example
`%USERPROFILE%\Murmur`).

Always repeat the same `--data-dir` and, if you used one, the same
`--service-name` in the follow-up command: another spelling selects another
service.

| Key after `service.helper.` | What happened | What to do |
|---|---|---|
| `error.admin` | The Service Control Manager refused access. | Run the command again from an elevated terminal under the same Windows user. |
| `error.create` | Windows refused to create the service. | Run elevated; if it persists, check that no other program created a service with this name (`sc.exe query <name>`). |
| `error.alreadyInstalled` | A service with this name already exists; nothing changed. | Use `service start`, or `service uninstall` first to reinstall. |
| `error.notInstalled` | There is no service with this name. | Run `service install` with the same `--data-dir` and `--service-name`. |
| `error.existingCheck` | The existing service could not be inspected; nothing changed. | Run elevated and retry. |
| `error.start` | The Service Control Manager refused to start the service. | Retry `service start` elevated; if the service log exists, it may show why. |
| `error.startStopped` | The service stopped right after launch. | Read the service log; the daemon usually reports the cause (profile, Node, broker). |
| `error.startTimeout` | The service did not reach Running in time. | Retry once; if it repeats, read the service log. |
| `service.leftRunning` | The service started but left the Running state during the startup check. | Read the service and daemon logs, fix the cause, then `service start`. |
| `service.cannotStart` | The service cannot start with its current configuration. | Reinstall: `service uninstall`, then `service install` with the same options. |
| `daemon.didNotLive` | The daemon exited within seconds; installation was rolled back. | Run `murmur doctor --json` with the same `--data-dir`; check that the profile exists at that exact path and is readable by the service. |
| `daemon.didNotStart` | The daemon did not start in time; installation was rolled back. | Read the service log, fix the reported cause, install again. |
| `daemon.failedStart` | The daemon process could not be started. | Check Node (22.13 or newer) and the runtime folder, then install again. |
| `daemon.restartEarly` | The daemon restarted during the initial check. | It is crashing; read the service log before installing again. |
| `daemon.restartStorm` | The daemon restarted too many times in the last hour. | Read the service log; fix the cause, then `service start`. |
| `install.rollbackFailed` | Installation failed and the rollback also failed; the service may remain registered. | Run `service uninstall` elevated with the same options, then install again. |
| `error.uninstallState` | The service state could not be read; no files were changed. | Run elevated and retry `service uninstall`. |
| `error.unchanged` | The operation failed before changing anything. | Retry elevated; nothing was changed, and no log may exist for this step. |
| `error.serviceState` | The service state could not be read. | Run elevated and retry. |
| `error.readConfig` | The service configuration could not be read. | Run elevated; if it persists, reinstall the service. |
| `error.readState` / `error.parseState` | The service state file could not be read or parsed. | Reinstall the service; the profile and its keys are not affected. |
| `error.profileDir` | The profile directory is unusable for the service. | Check that `--data-dir` exists and is the same absolute path used at `join`. |
| `error.path` | A configured path is not absolute. | Pass absolute paths. |
| `error.node` | Node was not found for the service. | Install Node 22.13 or newer, or run the CLI with the Node you want the service to use. |
| `error.entry` | The daemon entry point was not provided. | Use the CLI from a complete runtime (release ZIP or npm package), not a partial copy. |
| `error.mode` | The helper could not tell whether it runs as a service. | Retry; if it persists, report the code. |
| `spec.read` / `spec.parse` / `spec.required` | The service launch file is missing, unreadable or incomplete. | Reinstall the service. |
| `spec.aclRead` | The permissions of the service launch file could not be read. | Run elevated and retry. |
| `spec.insecure` | The service launch file is writable by accounts other than SYSTEM and Administrators; the helper refuses to run it. | Reinstall the service elevated; do not edit files under `%ProgramData%\Murmur` by hand. |
| `acl.read` / `acl.build` | The helper could not read or set permissions on its data folder. | Run elevated and retry. |
| `previous.own` | `service install --replace-previous` found this installation's own Service; nothing was changed. | Use `service start`, or `service uninstall` first to reinstall. |
| `previous.notMurmur` | The Service with this name runs another program; nothing was changed. | Choose another `--service-name`; Murmur does not remove other programs' services. |
| `previous.stopFailed` | The previous installation's Service did not stop; nothing was removed. | Retry elevated; if it repeats, stop it with `sc.exe stop <name>` and retry. |
| `previous.deleteFailed` | Windows refused to remove the previous installation's Service. | Retry elevated. |
| `previous.pending` | The previous Service is marked for removal but still registered, usually because the Services window is open. | Close the Services window or restart Windows, then retry. |
| `error.language` | The helper was given an unsupported language option. | Use `en` or `ru`. |
| `error.unknown` | The helper failed for a reason it has no key for. | Report the code, with the service log if one exists. |

This table follows the helper's English message catalog
(`spikes/windows-service-go/locales/en.json`) and the reason contract agreed for
2.11. A key missing here is still reported as `service.helper.<key>`; look it up
in that catalog.
