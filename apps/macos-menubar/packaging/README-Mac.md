# Murmur for macOS

Requires macOS 13 or newer and a Node.js version supported by the bundled engine.
The app contains Intel and Apple Silicon code. A downloaded DMG requires no compiler,
Git or npm. Node is installed separately; the app reads its minimum version from
the bundled engine's `package.json → engines.node`.

[Русская инструкция](README-Mac.ru.md)

## Install the DMG

Open the image, move `Murmur.app` to the `Applications` alias, then open it from
Applications. The engine is inside the app. Opening the app requires no Terminal
commands, `.command` launcher, adjacent runtime folder or Node binding file.

Murmur checks standard Node.js and Homebrew installation paths, Volta, nvm and fnm.
If Node is missing or too old, a dialog links to the official download page and
lets you retry. It does not install Node automatically.

Murmur opens a window with **I have an invitation…** as the primary path. Select the
private invitation sent by your teammate; Murmur creates a profile and reply file.
Use **Show reply file** to find what to send back. Then click **Start Murmur on this Mac**
to install and start the profile’s background service. After exchanging the reply,
use **Check connection**. Creating a profile is not proof of pairing or live agent delivery.

If you own a server, **Create a profile for my server…** asks for its address and an
optional access file. A unique name and private profile folder are chosen automatically;
you may change the name. There is no default public server. Previously configured users
can choose an existing profile folder. The menu bar icon toggles this window; right-click
for quick actions. Before profile selection, the quick menu still contains only
**Choose profile folder…** and **Quit**.

Profile, key and service writes go through `/Applications/Murmur.app/Contents/MacOS/murmur`: `init` or `join`
for creation, then explicit `service install` and `service start`, with a fresh check of
the same agent identity before each service mutation. Keys are not regenerated on start.
The helper runs only the bundled engine and preserves literal arguments without a shell.
Before creation, the app saves a private recovery record containing only the chosen
identity, paths derived from its identifier, and progress. If verification fails,
the saved setup shows the original paths and lets you check the same profile without
repeating creation. A confirmed write is shown separately from an unconfirmed command.
Retrying creation is offered only when the command has finished and no profile or reply
files exist. Previous nonempty private profile folders are listed before a separate
profile can be created. No profile, reply or key files are deleted by recovery.
If the record is damaged or an interrupted setup cannot continue, **Reset saved setup
record…** asks for confirmation and keeps a private copy of that record. You then
choose an existing profile or explicitly create a separate one; resetting never
retries creation automatically. The copy remains available in Finder after reopening.
Choosing an earlier private profile restores its reply link and service setup steps
after checking the same identity. It does not create the profile again.
Agent-client connection still uses the shared
[onboarding instructions](https://github.com/alexfrmn/murmur/blob/main/docs/setup-onboarding.md).

English is the default app language, independently of macOS. Choose
**Settings → Language → Русский** for Russian or **Настройки → Язык → English** to switch back. The choice
is saved and applies to the menu, status messages, diagnostics and Node errors.
Native macOS dialogs continue to follow the system language. Protocol fields,
agent IDs, file paths and diagnostic codes are not translated.

Stop your service before replacing or moving an installed app whose engine it uses.
Opening the app does not stop or reconfigure existing services.

## If the menu bar icon is missing

Murmur can be running while macOS hides its icon behind the camera notch or other
menu bar items. Open Murmur again from Applications, or press **⌃⌥⌘M**
(Control–Option–Command–M), to bring up its window. The shortcut also hides the
window. If another app has reserved it, Murmur shows a fallback message in the footer.

To recover the icon, first free some menu bar space in System Settings → Menu Bar.
Once the icon is visible, hold Command and drag it toward the right. Murmur saves
that position. macOS also has advanced `NSStatusItemSpacing` and
`NSStatusItemSelectionPadding` preferences that affect all menu bar items; Murmur
does not change them.

## First opening

The app has an ad-hoc signature, without Developer ID or Apple notarization.
A DMG does not remove Gatekeeper warnings. `Read Me First.txt` inside the image
contains the first-opening instructions in English, followed by Russian.

A GitHub download through Safari was tested on macOS 26.6.2 with a Russian interface:

1. Select the installed Murmur in Applications and open it (⌘O).
2. A warning titled «Файл «Murmur» не был открыт» appeared, with
   «Переместить в Корзину», «Готово» and «Справка». Select «Готово» (Done).
3. Right-click the installed Murmur and select «Открыть» (Open) in Finder's menu.

In that test the app process started without a second dialog, password, Touch ID or
security setting change. These observations apply to that exact downloaded build,
not to every Mac. The four logical opening actions exclude download and installation.

On other macOS versions Apple also describes allowing the specific app through
System Settings → Privacy & Security → Open Anyway; authentication may be required.
That button was not observed in this macOS 26.6.2 test.
[Apple's instructions](https://support.apple.com/102445).
Keep Gatekeeper enabled. A warning that an app is damaged or contains malware is
not interchangeable with an unidentified-developer warning.

## Build a DMG

From `apps/macos-menubar`, with a separately built and verified runtime:

```sh
./packaging/build-dmg.sh /absolute/new-output /absolute/prebuilt-runtime
```

The build host needs Swift, Python 3 and compatible Node. The script validates the
runtime inventory and hashes, builds both architectures, runs checks for the host
architecture, packages the English and Russian resources, signs the app ad-hoc,
and verifies the DMG. The image contains the app, Applications alias and one bilingual Read Me file.
Set an absolute `MURMUR_SWIFT_BUILD_ROOT` to reuse build caches; output must be new.
The version is read from the runtime manifest, not from the filename or release tag.
Both macOS version fields must match it before signing. The filename is
`Murmur-Mac-VERSION-universal.dmg`; a thin source build takes its version from the
root `package.json`. Unsupported nonnumeric Apple version forms fail the build.

Reproducible checks also run as part of the build:

- `python3 packaging/manifest-checks.py` checks missing, changed, extra and linked
  payloads, including Python optimization mode.
- `python3 packaging/localization-checks.py /absolute/path/Murmur.app` checks shipped
  catalogs, default language, format placeholders and coverage of source keys.
- `python3 packaging/native-bridge-check.py /absolute/path/Murmur.app` checks the actual
  engine, literal arguments, PID preservation, environment isolation and incomplete bundles.

Checks use disposable fixtures and do not create user profiles or services.
Node probing checks compatibility of an executable; it does not attest its origin.
SwiftPM resources are copied inside the app before signing, so the distributed app
uses its own catalogs rather than paths on the developer's machine.

## Legacy ZIP

Older ZIPs use `Open Murmur.command`, a sibling `runtime` directory and a `murmur`
launcher. Keep that folder together. On macOS 26.6.2 an ordinary opening of the
`.command` file was blocked by Gatekeeper in the observed test.
The launcher checks Node and creates a local `.murmur-node` binding. Rerun it after
moving Node; an absolute `MURMUR_NODE` can select a nonstandard installation.
`Open Murmur.command --check` checks the binding without launching the GUI.
It refuses to change the binding while Murmur is running.

`packaging/build-universal.sh` builds this older layout. Launcher checks are available
as `python3 packaging/launcher-checks.py`. The DMG is the current packaging path.
