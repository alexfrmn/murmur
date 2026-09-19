# Product version and update checks

`murmur version --json` reports `murmur.version/1`:

```json
{"schema":"murmur.version/1","product":"Murmur","version":"2.9.0","source":"root-package-json","comparison":"declared-release-version"}
```

The only version source is the installation's **root `package.json.version`**,
which is the product release version. Package versions such as setup/core are
independent. This reports the declared product version, not the revision of a
source checkout, the contents of an installed artifact, or a live daemon's version.
Today's source checkout can contain fixes made after the identically numbered tag.
No Git/package-version fallback is used if the root manifest cannot be validated.

`murmur updates check --json` compares that version with the published stable
release from GitHub's public API. It returns `murmur.updates/1`; all fields below
are required, including explicit nulls. Unknown additive fields may be ignored.

| Field | Type / meaning |
|---|---|
| `schema` | `"murmur.updates/1"` |
| `channel` | `"stable"` |
| `currentVersion` | string or null; root product version |
| `versionSource` | `"root-package-json"` |
| `comparison` | `"declared-release-version"` |
| `enabled` | boolean; effective preference |
| `state` | `"up-to-date"`, `"available"`, or `"unknown"` |
| `reason` | stable code below; never a raw server error |
| `latestVersion` | stable release version, or null if not established |
| `releaseUrl` | validated official release page, or null |
| `action` | `"open-release-page"` only when available; otherwise null |
| `checkedAt` | UTC timestamp of the last network attempt, or null |
| `lastSuccessAt` | UTC timestamp of the last successful observation, or null |
| `nextCheckAt` | earliest next attempt, or null |
| `cached` | true when this invocation reused a recorded attempt |
| `stale` | true when a previously successful observation could not be refreshed |
| `checkIntervalMs` | 21600000 (six hours) |
| `timeoutMs` | 4000 |

`up-to-date` means **no newer declared stable release was observed**, including
when the local version is ahead of the published release. It does not certify
matching source bytes, signatures or installation completeness. A failed check
returns `unknown`, never `up-to-date`. A fresh cached answer retains its original
timestamp; it is not presented as a new network observation. After expiry, network
failure clears actionable release fields, reports `unknown`, and preserves the
last successful observation's timestamp. Never hide the timestamp in a consumer.

Success reasons: `updates.newer-release`, `updates.no-newer-release`.
Unknown reasons: `updates.disabled`, `updates.current-version-invalid`,
`updates.preferences-unavailable`, `updates.cache-invalid`,
`updates.cache-unavailable`, `updates.check-in-progress`, `updates.interrupted`,
`updates.network-error`, `updates.timeout`, `updates.rate-limited`,
`updates.http-error`, `updates.release-invalid`.

Both local and release versions must be stable three-component SemVer (optional
build metadata is ignored for comparison). Prerelease and draft responses are
rejected, even if the API returns one unexpectedly. Unrecognized versions produce
`unknown`; no approximate or lexicographic comparison is used. Release page URLs
are restricted to this repository; response bodies, credentials and arbitrary
URLs are never returned to the shell.

## Scheduling, privacy and disabling

Checks are enabled by default. Only `updates check` contacts GitHub. Ordinary CLI
startup, `version`, `status` and `doctor` do not implicitly check for updates.
Native clients should invoke it asynchronously after startup and no more often
than every six hours; status rendering and service controls must not wait for it.
Keep update availability separate from the messaging health indicator.

The CLI sends an **unauthenticated HTTPS request to GitHub**. GitHub learns the
source IP address and that Murmur's update checker is used. No agent ID, profile
path, broker address, token or keys are sent. There is no telemetry endpoint and
no use of `GH_TOKEN` or other stored credentials.

Disable persistently with `murmur updates disable --json`; re-enable with
`murmur updates enable --json`. These return
`{"schema":"murmur.update-preferences/1","enabled":false}` (or true).
`MURMUR_UPDATE_CHECK=0` overrides the persistent preference for that process;
enabling cannot override it. Disabling never starts a request. It affects future
checks and does not cancel a request already started by another process.

Preferences/cache are shared across profiles of the current OS user:

- macOS: `~/Library/Application Support/Murmur/updates`
- Windows: `%LOCALAPPDATA%\Murmur\updates` (user AppData/Local fallback)
- Linux: `${XDG_STATE_HOME:-~/.local/state}/Murmur/updates`

This directory contains only preferences, release metadata and a temporary lock,
not identity or message data. `--data-dir` and `--service-name` do not select an
update cache. An unreadable preference fails closed without networking. Failed
attempts are cached for six hours too; there is no force switch that bypasses the
limit. Concurrent CLI checks share a lock, and a recorded pending attempt survives
process interruption. Corrupt/future-dated cache data is reported as unknown.

The consumer may **open the supplied release page on an explicit click** when
`action` is `open-release-page`. Nothing is downloaded or executed by the CLI.
There is no automatic installer, signature claim, or automatic restart. Artifact
signing and installation remain separate release work.

Sources: [GitHub latest release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
excludes drafts/prereleases; [unauthenticated API limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
are shared per originating IP (60 requests/hour). The six-hour per-user cache
reduces traffic but cannot reserve an IP-wide allowance shared with other users.
