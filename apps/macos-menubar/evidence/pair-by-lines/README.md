# Pair by lines — native source acceptance

Baseline: `4772afaa5035bba8e7104ebebe11e8f099e360db`.
The before images render its actual `MurmurHomeView`; only automatic runtime
startup is disabled for capture. After images render this branch's actual Home
and PairingSheet with AppKit/SwiftUI in English and Russian. These are native
view captures, not a claim of a manually clicked or downloaded release test.

`../pairing-native.swift` links the app's views/model and MurmurTrayCore, excluding
the production entry point `DesktopEntry.swift`. Its `HOME` and
`CFFIXED_USER_HOME` must both equal `<argument-1>/home`; it asserts this before
creating anything. Argument 2 is `en` or `ru`. `MURMUR_BIN` selects the CLI under
test; all inherited `MURMUR_*` values are cleared before this explicit selection.
The local run used the installed, verified engine at the baseline SHA above.

The harness invokes the same model actions as the buttons and checks the real
macOS clipboard. Each language gets separate disposable Identities and a
generated access key. The private loopback Server is rejected when creating an
Invitation, then an explicit public-shaped `.invalid` address is used. No Server
is contacted, Service installed, Assistant launched or live profile modified.
Screenshots show no Invitation credential; the displayed Reply contains only
the disposable Identity's public keys.

Twenty-two native checks per language cover: public address prompt; refusal to expose
or copy the Invitation before consent; Invitation clipboard content; stdin join;
Reply clipboard content; stdin add-peer; both Contacts observed in status; and
the private recovery copy of the Reply; cancellation; and creating the first
inviting Identity before opening the Invitation sheet. The added checks cover the
current Identity form; refusal of different tokens with byte-identical settings;
joining with the same Identity, profile and keys; copying its Reply and confirming
both Contacts; refusal of a different Server with unchanged settings; and refusal
after the selected profile changes. Invitations and Replies include messenger
wrappers, repeated identical quotes and Unicode Cf characters during successful
native flows. First-time join and Reply import use standard-base64 lines through
the real engine's legacy decoder; the existing Identity receives base64url.
The private copy is not a file exchange
step. These checks do not establish message transport, Wake-up, or two-person
completion time; that remains a separate live acceptance.

Review regressions use the actual `TrayModel` to check a multiline access file
against the real CLI, plus a local init-only stub for permission denial and a
20-second timeout. All three own-Server errors preserve their original reason;
first-time join still receives Invitation-specific errors. An unavailable status
blocks joining the selected Identity with an explanation and byte-identical
settings. After copying, Invitations stay out of the visible output both with
and without a Server key. The corresponding view captures contain no Invitation
line; Reply captures still use only disposable public keys.

The parser matches Windows #261 at `1bcba16`: strip Unicode Cf characters, then
extract `MURMUR:[A-Za-z0-9_+/-]+={0,2}`. Identical repeated tokens are accepted;
different tokens or no token are refused. Legacy base64, zero-width spaces,
soft hyphens and bidi marks are covered alongside signature/quote/fence cases.
ASCII token extraction uses UTF-16 regex offsets directly, including when a
combining accent, variation selector or skin-tone modifier follows the token.
The 16 KiB bound applies to the original paste. The engine rejects tokens
truncated by ordinary line breaks.

See `verification.txt` for commands and counts. The final commit is the PR head;
images and evidence belong to that source revision, not an installed release.

The recovery follow-up adds a 23rd native check per language: “Invite a
colleague” cannot open creation when the selected Identity's status is missing.
Its counts and path-free before/after captures are in `../recovery-guards/`.
The six init-error images here were replaced with `CreateProfileSheet` component
captures, so temporary profile paths no longer appear. `verification.txt`
preserves the original P1 run; the follow-up has its own verification log.
