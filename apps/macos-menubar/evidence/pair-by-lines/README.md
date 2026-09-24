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

Sixteen native checks per language cover: public address prompt; refusal to expose
or copy the Invitation before consent; Invitation clipboard content; stdin join;
Reply clipboard content; stdin add-peer; both Contacts observed in status; and
the private recovery copy of the Reply; cancellation; and creating the first
inviting Identity before opening the Invitation sheet. The added checks cover the
current Identity form; refusal of an ambiguous paste with byte-identical settings;
joining with the same Identity, profile and keys; copying its Reply and confirming
both Contacts; refusal of a different Server with unchanged settings; and refusal
after the selected profile changes. Invitations and Replies include messenger
wrappers during the successful native flows. The private copy is not a file exchange
step. These checks do not establish message transport, Wake-up, or two-person
completion time; that remains a separate live acceptance.

The parser follows the Mac request literally: one match of
`MURMUR:[A-Za-z0-9_-]+=*`; zero or multiple matches are refused, including two
identical tokens. Common signature/quote/fence cases are shared with Windows
#261. Its later duplicate normalization, zero-width removal and legacy base64
acceptance are not part of this Mac contract. The engine rejects truncated tokens.

See `verification.txt` for commands and counts. The final commit is the PR head;
images and evidence belong to that source revision, not an installed release.
