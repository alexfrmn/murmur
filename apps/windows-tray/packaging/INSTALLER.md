# Per-user Windows installer

Build from the same verified extracted payload as the Windows ZIP. The installer
does not download Node, invent a profile, install a service, or configure a client.
It preserves the launcher's first-run flow and therefore cannot repair missing
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
`Programs\Murmur\Murmur.lnk`, pointing to installed Open-Murmur.ps1. The launcher
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
