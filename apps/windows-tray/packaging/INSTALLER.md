# Per-user Windows installer

Build from the same verified extracted payload as the Windows ZIP. The installer
does not download Node, invent a profile, install a service, or configure a client.
It opens the tray directly (no PowerShell console) and cannot repair missing
onboarding in an older payload. A 2.10 rehearsal is not 2.11 GUI acceptance.

```powershell
./apps/windows-tray/packaging/build-setup.ps1 `
  -BundleDir C:\release\windows-extracted -OutputDir C:\release\output `
  -Compiler 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
```

For an older verified release with its own checker, pass `-BundleChecker` pointing
to that release's checker explicitly. Never compile an unverified directory.
The wrapper checks the payload, takes the version from its manifest, compiles,
and records artifact SHA256 and bundle provenance alongside the executable.

Setup uses `PrivilegesRequired=lowest`, installs under
`%LOCALAPPDATA%\Programs\Murmur`, and registers an HKCU uninstaller. Installation
itself requires no administrator token. A later service operation may request
elevation through the application.

Shortcut ownership is coordinated with the launcher: setup owns only
`Programs\Murmur\Murmur.lnk`, pointing to installed murmur-tray.exe. The launcher
owns flat Programs, Desktop and Startup links and supplies the selected profile
and service. Uninstall removes those launcher links only when description,
PowerShell target, working directory and quoted launcher path match this install.
Foreign links are retained. Profile directories and SCM services are never
deleted. A service referencing the installed runtime must be managed separately
before uninstalling its runtime; this installer does not silently stop it.

CI handoff to release maintainer: on the native Windows bundle job, provision
Inno Setup 6, run this wrapper against the verified extracted release directory,
then upload `Murmur-*-windows-x64-setup.exe` and its `.json` proof beside the ZIP.
Use the same source checkout and release version. Publishing remains a separate
release action. Unsigned installers retain Windows first-open warnings.

Acceptance remains separate: visible wizard pages, clean install, launch,
owned-shortcut cleanup and uninstall; preserve an unrelated shortcut/profile
sentinel. Startup-after-login and application onboarding need their own live
checks. Do not call compilation alone installation acceptance.

For local acceptance compile with `/DAcceptanceTest=1`: a distinct AppId,
application name, Start Menu folder and default install directory prevent
registration or shortcut collisions with a real Murmur installation. This build
is not a release artifact. A silent install deliberately does not launch the app
(`skipifsilent`); verify launch separately using its exact installed exe path.

Setup/upgrade and uninstall now refuse while any registered Windows service ImagePath references this installation directory (including a runtime path in arguments). The check is read-only and also protects stopped services; no service is stopped or deleted automatically. Failure to enumerate services aborts. Paths using junction or short-name aliases are not resolved by this string check and remain an acceptance limitation.

Managed launcher shortcut cleanup accepts both the original PowerShell/Open-Murmur.ps1 target and the direct installed murmur-tray.exe target with empty arguments. Both require the exact managed description and installation working directory; a shortcut into another installation is preserved.
