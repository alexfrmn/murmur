# Per-user Windows installer

Build from a verified extracted Windows release bundle using build-setup.ps1:

```powershell
./apps/windows-tray/packaging/build-setup.ps1 -BundleDir C:\release\windows-extracted -OutputDir C:\release\output -Compiler 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
```

For an older bundle, explicitly pass its matching -BundleChecker. The wrapper verifies payload files, uses the manifest version, and records installer SHA256 and source provenance. This installer requires external Node as specified by the bundle; it does not configure identities, clients or SCM services. PrivilegesRequired=lowest, default destination LOCALAPPDATA/Programs/Murmur, HKCU uninstall registration.

## Installed and portable ownership

Setup owns one Start Menu entry Programs/Murmur/Murmur.lnk. Its Startup task is selected by default and creates Startup/Murmur.lnk minimized; Desktop/Murmur.lnk is optional. Every shortcut targets the installed murmur-tray.exe with empty arguments and the installed working directory. Setup writes murmur-install.json containing installer=setup, appId and version. The portable launcher must detect this marker and leave installed shortcuts alone; without the marker the ZIP launcher owns its shortcuts. That matching launcher change is a release dependency.

Setup asks before replacing an occupied shortcut that belongs to another installation, for example one left by a pilot build: "Found a shortcut from a previous Murmur installation — replace it?" (the default button is No). Declining keeps the shortcut and stops setup with a localized message; nothing is deleted during this check, and [Icons] replaces the shortcut only after every dependency check passes. Silent setup replaces selected shortcuts by default; `/SHORTCUTCONFLICT=fail` makes it stop with exit code 7 instead. It removes an old owned flat Programs/Murmur.lnk to avoid duplicate Start entries. The same ownership check is used for upgrade and cleanup. It recognizes either Windows PowerShell with -File and the quoted installed Open-Murmur.ps1 argument or the installed tray with empty arguments; both require the exact managed description and installation working directory. Uninstall and cleanup never delete a shortcut that fails this check.

## Update and uninstall

Before copying or deleting files, setup queries Windows services read-only and refuses if a registered service references this installation. The service must be managed separately; profiles and services are never deleted or stopped by setup. The service path check does not resolve junction/short-name aliases.

Setup then enumerates tray processes through WMI and terminates only processes whose ExecutablePath equals the installed murmur-tray.exe, waiting for exit. It never terminates another bundle by process name alone. Like the service check, this exact-path comparison does not resolve junction or 8.3 short-name aliases; close a tray launched through such an alias before maintenance. An update restarts a previously running tray, including silent updates. A fresh silent install does not launch; an interactive install offers launch on completion. If the tray cannot be stopped, a clear refusal replaces the file-in-use failure. Uninstall removes the ownership marker and installed files/shortcuts.

## Build and acceptance

Provision Inno Setup 6 on the native Windows bundle job and run the wrapper against that job's verified payload. Upload executable and adjacent proof JSON alongside ZIP; publishing remains a separate release action. Unsigned binaries retain Windows first-open warnings.

Compile local tests with /DAcceptanceTest=1 for separate AppId, install directory and shortcut names. Tests should cover clean install, marker/default Startup, upgrade with a running tray (one restarted process), uninstall (zero own processes/files), foreign-bundle survival and foreign-shortcut refusal. Native tests and shortcut inspection do not prove a reboot/login or complete onboarding GUI journey.

When automating setup from PowerShell 7, wait for the setup process itself:

```powershell
$p = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT', '/NORESTART' -PassThru -WindowStyle Hidden
$p.WaitForExit()
$p.ExitCode
```

Avoid Start-Process -Wait here: it waits for the process tree, including the tray restarted by an update, which makes a completed update appear stuck.
