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
lets you retry. It does not install Node, create profiles or install services for you.

Choose an existing profile folder from the menu bar icon. Profile creation, client
connection and service installation still use the shared CLI at
`/Applications/Murmur.app/Contents/MacOS/murmur`. See the
[onboarding instructions](https://github.com/alexfrmn/murmur/blob/main/docs/setup-onboarding.md).
The helper runs only the bundled engine and preserves literal arguments without a shell.

English is the default app language, independently of macOS. Choose
**Language → Русский** for Russian or **Язык → English** to switch back. The choice
is saved and applies to the menu, status messages, diagnostics and Node errors.
Native macOS dialogs continue to follow the system language. Protocol fields,
agent IDs, file paths and diagnostic codes are not translated.

Stop your service before replacing or moving an installed app whose engine it uses.
Opening the app does not stop or reconfigure existing services.

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
