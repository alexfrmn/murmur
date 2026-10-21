# Murmur AIM · N1 · AIM 9

Current local edition: AIM 9, engine 2.12.0, 6 October 2026. Architecture, roster
differences, permission boundaries and proposed team access are documented in
[AIM-ARCHITECTURE.md](AIM-ARCHITECTURE.md). Earlier sections below retain their
edition-specific behavior; AIM 5 supersedes the original global shortcut.

Personal macOS edition of alexfrmn/murmur. Upstream engine 2.12.0; MIT attribution
and transport remain intact. The fork adds the AIM Native White shell, with MEM
PRISM as the visual reference. The stock Mac app was not installed previously.

## Current design: N1

White canvas, Plex Mono 400/500/600 bundled with OFL, 8 pt controls, 16 pt spacing,
neutral navigation with a small red indicator. Header, tabs, pin, footer and
surface use the shared AIM components vendored byte-for-byte; hashes live in
`aim-shared-receipt.json`. The existing AIM family mark identifies this personal
edition; there is no new suite-wide glyph. Menu bar: 18 pt template mark; header:
family voxel; Dock/Finder: the same family mark on a white tile.

Primary profile is N1 operator. Desktop-only fixed 740 pt width, resizable height;
mobile is not applicable. The underlying pairing, language, preferences, service,
client connection, doctor and update flows stay upstream. Settings remains a
header action. The shared surface handles Escape, Command-W, close, outside click
and menu-bar toggle; pin keeps the window open. Existing Ctrl-Option-Command-M
shortcut is retained and avoids MEM PRISM's Option-Command-M.

The app has its own bundle/preferences identity, `org.aimindset.murmur`. It does
not copy keys, create a new identity on launch, register at login, change MCP
settings or take ownership of the owner's server identity. An existing local profile can be
chosen through upstream's verified recovery flow. The server companion uses the existing SSH alias for owner-only observations and
explicit user messages. Remote conversations retain their existing server monitor.

## Build

Download `murmur-runtime-2.12.0.zip` from the upstream release, verify its SHA256
against the upstream `SHA256SUMS.txt`, extract it, then run:

```
bash apps/macos-menubar/packaging/build-aim.sh /absolute/path/to/runtime
```

Requires Swift 6 and external Node 22.13+. Builds the current host architecture,
checks the shared fixtures, verifies the runtime file manifest, and ad-hoc signs
`apps/macos-menubar/dist/Murmur AIM.app`. It is a local build, not notarized.

Install with `ditto` into an unoccupied `~/Applications/Murmur AIM.app`. Preserve
an existing app before upgrading; never overwrite an occupied installation blindly.
Launch normally to open the window, or `open -g ... --args --background` to start
with just the menu bar. The latter keeps the owner's meeting focus unchanged.

Offscreen preview, without profile/network activity:

```
MurmurMenuBar --aim-render /absolute/path/preview.png
```

`--demo` optionally exercises the upstream labelled demo state. Preview never
shows a window or registers the shortcut. Shared first-appearance motion follows
Reduce Motion. Real pairing, reboot/login and automatic assistant wake are not
claimed by these fixture/offscreen checks.

Upstream release updates open the upstream page. They do not rebuild the AIM
edition; rebuild this fork to retain the customization.


## AIM 2 – server companion, 2026-09-29

The default Overview reads an owner-only projection over the owner's existing SSH alias (`AIMOwnerSSHHost`), once per minute while running. It uses `companion.py` in the configured server root (`AIMServerRoot`). No daemon, timer, local identity, broker key or responder is created. Profile onboarding remains in Local.

The server retains delivery and native WakeMonitor ownership. A live systemd service is displayed independently from the dated budget receipt. Unknown/stale data remains visibly stale. People show observed message dates, not online presence. Alex decisions and incoming review candidates are separate counts.

In AIM 2, opt-in macOS notifications contained counts only; AIM 3 also shows sender names. Notifications use a quiet first baseline and persisted SHA-256 event fingerprints. The app keeps people/questions in memory. It opens the private dashboard, topic deep links and the owner's dedicated Codex session; it does not copy session context or choose a responder from the foreground app.

Prerequisites: existing SSH alias and host trust, Tailscale, server projection. A failed SSH read times out after 20 seconds and cannot start a second overlapping read. UI refresh uses no model calls. Disconnect stops only this app's read loop.

Runtime remains upstream 2.12.0; AIM shell edition 2. The local app and source are an AIM fork, not a second server deployment.

## AIM 3 · 2026-10-02

People is a dedicated server roster with initials, verified nicknames and exact agent IDs.
The English interface is the default; Russian remains selectable. Original message and
question text keeps its source language. People are told apart by person ID and exact agent bindings,
never by a similar display name.

Write message sends only after the user presses Send message, through the existing
SSH identity to the owner-only `mesh-comms/send.py` helper. A stable UUID is retained
for the attempt. Uncertain results expose Check delivery without silently resending.
The helper validates current peer configuration, excludes retired/private profiles,
adds human attribution and uses the upstream idempotent encrypted sender. Queued,
acked and answered are different states. No message body enters an HTTP endpoint.
No real outbound messages are sent by the test suite.

The existing server timer collects every two minutes. The app reads every minute
while open, with a quiet first notification baseline. Model responders remain subject
to the budget guard. Keep one Telegram bot poller: the existing owner-only bridge accepts
`/to agent-id message` in the Murmur group. A configured peer is not proof that the
recipient imported the pairing reply or can wake an agent.

This build is an operator companion configured for the owner's SSH alias. The public catalog
contains product documentation and synthetic previews only; it does not distribute
credentials, connection invitations, private messages or a universal installer.

## AIM 4 · peer-specific reply evidence and companion sharing

People shows each peer's configured responder and the last wake outcome. A running
Codex service or global budget receipt does not establish that a given peer has a
responder. The Telegram button opens a human chat; it never sends a message.

Access & context edits a server-owned, revisioned companion policy. It can disable
companion sends and allow an owner-authored brief. Attaching that brief requires a
separate send-time choice and matching policy revision. Trust and tone are preferences;
they do not grant filesystem rights or silently rewrite manual text. The policy applies
to this explicit companion send path, not existing native responders, raw MCP or the
Telegram bridge. Automatic context export remains absent. The dashboard editor uses
the same policy with owner authentication, exact Origin validation and CAS updates.

## AIM 5 · 2026-10-02 · family shell

- Menu bar app: `LSUIElement` true and `setActivationPolicy(.accessory)`; the `.regular` call in `main` overrode the plist and kept a Dock icon up to AIM 4.
- Global key `⌥⌘U` in the family pattern, stored as `org.aimindset.murmur.hotkey`, recorded by pressing it in Settings (`FamilyHotkey.swift`, shared byte for byte with krest); AIM 4 registered a fixed `⌃⌥⌘M` outside the family table.
- Pin survives a restart: `org.aimindset.murmur.pinned`, migrated once under `aim.shell.pin-migrated`.
- Theme `org.aimindset.murmur.theme`, white by default: □ / ■ in the footer, a Settings row; SwiftUI colours read the shell roles, `preferredColorScheme(.light)` and the white literals are gone, a switch applies at once without a restart.
- Footer `apps ↗` opens the catalog root, the same address as the siblings; tab hints; 91 tooltips (`.help`) with English and Russian strings (109 new catalog keys, 670 per language).
- Fonts load from the resource bundle packaged in `Contents/Resources`. The generated `Bundle.module` fell back to the build directory under ~/Documents, and a freshly signed build waited on privacy consent there before its first frame.
- Checks: 503 upstream checks, runtime manifest, native bridge, localization (670 keys), `--aim-check-shell` 9/9, offscreen renders of both themes and a live flip (`--aim-flip`).

## AIM 6 · 2026-10-04 · menu presence

Preserves the preceding AIM 5 shell work (theme, persistent panel pin, family hotkey,
localizations and packaged fonts). The header uses the current byte-identical family
voxel model; the menu uses the canonical 18 pt monochrome template mark.

The status item now has fixed square width, is explicitly visible at launch, and
recovers only its own invalid saved position (negative or beyond connected screen
width). A valid Cmd-drag position survives restarts. Counters remain in the tooltip
and panel. Panel pinning controls focus-loss behavior independently of menu placement.

`AIMShellEdition` and `AIMSourceCommit` in the bundle identify the installed build;
engine version remains 2.12.0. A private `Murmur/aim-menu-receipt.json` in Application
Support records placement, template image, activation policy and panel state once
at launch. No identity, grant, login item, worker or scheduler is added. Menu-manager
hiding and notch occlusion require visual inspection; a frame receipt alone is not
proof of visible pixels. Login/reboot startup is not newly configured.

Checks: shared component hashes, 14 shell checks (including invalid-position recovery,
valid-placement persistence and template mark), packaging/runtime checks and scoped
installed-process acceptance. Release receipt is retained by the owner task.


## AIM 7 · local test · 2026-10-05

The owner companion now searches ordinary server message text explicitly and reads
a selected result on demand. The bundled `mesh-comms-query.py` reader executes
in memory through the existing owner SSH alias; it installs no server files,
marks no inbox items read, starts no model and excludes private message bodies.
Search result labels resolve the human and agent from the observed roster.

Open questions are grouped into the owner's decisions, agent work, the other side and
items needing verification. Private connections have a separate status-only
section. Only an exact verified peer-to-owner mapping opens a Codex chat; there
is no generic JARVIS fallback for other people. Existing explicit composer and
per-peer sharing policies remain separate from responder/file permissions.

This edition is a local test. No remote release, dashboard deployment, policy
change or recipient message is part of its preparation. Existing menu placement
recovery, persistent panel pin, N1 shell and English/Russian choice are retained.
Canonical query helper: team-ai-infrastructure/worldstream/scripts/mesh-comms-query.py.


## AIM 8 · shared shell local test · 2026-10-06

Receipt-verified shared exports supply Murmur's distinct peer-channel mark and
voxel, plus pin migration that preserves explicit stored choices. The app header,
menu template and app icon adopt the Murmur identity; Apps keeps the family catalog.
Settings stays in the same panel. Local Command-comma opens it, Escape returns to
the previous view, then hides the main panel without changing pin/theme. Dialogs
close first, and hotkey-recording Escape keeps the previous combination. Unmodified
1–4 navigate only outside text editors, attached sheets and recording.

A read-only local dashboard preview can be selected explicitly in Settings; its
URL is localhost:8768 and the canonical private board remains the other choice.
People link to their observed graph and show per-agent companion policy with its
observation date. Questions display review date and exact source message ID.
Dates use the Mac timezone. AIM 8 uses initials only; AIM 9 below completes the existing approved photo path.
This shell pass adds no photo upload, access grant, message or responder.

Sync only adopted shared assets with packaging/sync-aim-shared.py SOURCE_ASSETS;
all files are checked against the export receipt before any write. Offscreen and
runtime acceptance are recorded separately in the product chat's local receipt.


## AIM 9 · existing approved people avatars · 2026-10-06

People now display existing operator-approved roster photos. The bundled owner
reader carries exact photo/photo_note references even with an older server
companion. An on-demand owner SSH read accepts an exact current person ID, verifies
the fixed person-to-photo mapping, current privacy and pairing, the existing server
HTTP allowlist, a regular non-symlink file and a 256 KiB limit. No arbitrary URL or
request path is accepted. Native image decoding is bounded to 4096 pixels per side.
Images stay in process memory; no new photo sync, contact lookup, disk cache or
upload. Missing, disallowed and private/status-only references skip image reads;
unavailable or invalid files use initials. Existing photo_note is visible beside the name, including
the unconfirmed bank portrait warning. Private contours remain status-only.
Pin, theme, language, server selection and global key are preserved on local install.


## Private technical work metadata · 2026-10-21

Overview and status-only People rows show a separate technical work card with the
source observation date, age at snapshot, freshness and work observation date.
A stale companion envelope cannot make the source appear fresh. Known work codes
and processor locations have fixed localized labels; arbitrary private text and
traffic counts are not displayed. A verified owner-task UUID opens the private
Codex task independently of ordinary message Read/Write permission. This route
adds no grants, sends, wake, scheduler or human obligation.

The optional owner-side `mesh_comms_private.py` projector owns the allowlist. Older
servers without it retain unknown private freshness. `awaiting_fresh_inbound`
states that post-restart peer roundtrip evidence is still absent; prior handled
messages remain dated observations. `local_mac` identifies this operator's Mac
as the processor; the server stores metadata only.
