# W1 native Service heading evidence

Read-only measurement on macOS at 2026-09-24T09:17:21.575Z. The selected service-label adapter
returned `stopped`; the engine independently found the same
Identity/store's live PID and open SQLite file, yielding `running-unmanaged`.
The observed Server state was `connected`. The private configuration hash
was unchanged. No service was installed, started, stopped, or reloaded.

| Native heading | English | Russian |
| --- | --- | --- |
| Before: selected-label measurement | [before-en.png](before-en.png) | [before-ru.png](before-ru.png) |
| After: store-bound measurement | [after-en.png](after-en.png) | [after-ru.png](after-ru.png) |

These are native AppKit/SwiftUI bitmap captures of the `ServiceHeading` component
used by Home and Settings, rendered from the two live measurements. They are not
full-window screenshots and do not claim an installed-app update. The installed
Murmur.app, its runtime, profile, LaunchAgent and production Server were untouched.
Acceptance in the installed app remains a separate release/update step.

The renderer is [render-service-heading.swift](../render-service-heading.swift).
Build the Mac package, link this small executable with its MurmurTrayCore objects,
and place its resource bundle next to the executable (or use the debug SwiftPM
`PACKAGE_RESOURCE_BUNDLE_PATH` pointing at the bundle's parent). Arguments:
`input.json en|ru output.png`; input is `{"service": <measured status.service>}`.
It uses a volatile locale override and never calls the CLI or stores preferences.
No Identity, Contact, message, credential, or filesystem path is drawn.

PNG SHA-256:

- `after-en.png`: `3bdc3fcf342cdc04a597ddc9d8e20434e954509f1f5aa6315c75917c5189c038`
- `after-ru.png`: `69600d50f3cac3a303fd1783eb2bfd12023cffde32bddbb3464eb25fae276559`
- `before-en.png`: `8a74f70f464815bd5a207731d6e4751d4d429d59aeb9b3ec0984b5923bdf088e`
- `before-ru.png`: `f4fd17ccfd58889fb26a1badabb4e9fab87fe8c319a18dfd9c23f5716a0041c1`
