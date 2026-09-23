; Compile only a verified, extracted Windows release bundle.
; ISCC /DBundleDir="C:\release\windows" /DReleaseVersion=2.11.0 /DOutputDir="C:\release\out" murmur-setup.iss
#ifndef BundleDir
  #error BundleDir must name a verified extracted Windows release bundle
#endif
#ifndef ReleaseVersion
  #error ReleaseVersion must match the bundle manifest
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifdef AcceptanceTest
  #define InstallerId "Murmur.CodexWin.Installer.Acceptance"
  #define InstallerName "Murmur CodexWin Installer Test"
  #define InstallFolder "Murmur-codex-win-acceptance-only"
#else
  #define InstallerId "{{427756A9-E238-4E87-B289-8DA6AD302E8C}"
  #define InstallerName "Murmur"
  #define InstallFolder "Murmur"
#endif

[Setup]
AppId={#InstallerId}
AppName={#InstallerName}
AppVersion={#ReleaseVersion}
AppPublisher=Murmur
DefaultDirName={localappdata}\Programs\{#InstallFolder}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
DisableWelcomePage=no
UninstallDisplayIcon={app}\murmur-tray.exe
OutputDir={#OutputDir}
OutputBaseFilename={#InstallerName}-{#ReleaseVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#InstallerName}\Murmur"; Filename: "{app}\murmur-tray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\murmur-tray.exe"; Comment: "Open Murmur"

[Run]
Filename: "{app}\murmur-tray.exe"; Description: "{cm:LaunchProgram,Murmur}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runhidden

; No profile directories, SCM operations, wildcard uninstall deletion, or user
; client configuration are included. Inno removes only its installed payload.
; The launcher alone owns Desktop/Startup/flat Programs links because only it
; knows the selected profile and service. Installer ownership agreed with Claude.

[Code]
function ReferencesInstall(Command, InstallDir: String): Boolean;
begin
  StringChangeEx(Command, '/', '\', True);
  StringChangeEx(InstallDir, '/', '\', True);
  { Include the separator: Murmur-other is not this installation. Conservatively
    match runtime paths in arguments too, e.g. a service hosted by external Node. }
  Result := Pos(Lowercase(AddBackslash(InstallDir)), Lowercase(Command)) > 0;
end;

function ServiceDependencyError(): String;
var
  Names: TArrayOfString;
  I: Integer;
  ImagePath: String;
  Shell: Variant;
begin
  Result := '';
  try
    if not RegGetSubkeyNames(HKLM64, 'SYSTEM\CurrentControlSet\Services', Names) then
      RaiseException('Cannot enumerate Windows services');
    Shell := CreateOleObject('WScript.Shell');
    for I := 0 to GetArrayLength(Names) - 1 do begin
      if RegQueryStringValue(HKLM64, 'SYSTEM\CurrentControlSet\Services\' + Names[I], 'ImagePath', ImagePath) then begin
        ImagePath := Shell.ExpandEnvironmentStrings(ImagePath);
        if ReferencesInstall(ImagePath, ExpandConstant('{app}')) then begin
          Result := 'Windows service "' + Names[I] + '" still uses this Murmur installation. ' +
            'Remove that service through Murmur service management before updating or uninstalling these files, then try again. Your profile will be kept.';
          exit;
        end;
      end;
    end;
  except
    Result := 'Windows service dependencies could not be checked. No installation files were changed. Try again from an account that can read the service configuration.';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := ServiceDependencyError();
end;

function InitializeUninstall(): Boolean;
var
  Reason: String;
begin
  Reason := ServiceDependencyError();
  Result := Reason = '';
  if not Result then begin
    Log(Reason);
    SuppressibleMsgBox(Reason, mbError, MB_OK, IDOK);
  end;
end;

procedure RemoveOwnedLauncherShortcut(const FileName: String);
var
  Shell, Link: Variant;
  Launcher, Arguments: String;
begin
  if not FileExists(FileName) then exit;
  try
    Shell := CreateOleObject('WScript.Shell');
    Link := Shell.CreateShortcut(FileName);
    Launcher := ExpandConstant('{app}\Open-Murmur.ps1');
    Arguments := Link.Arguments;
    if (String(Link.Description) = 'Open Murmur controls (managed by Murmur)') and
       (CompareText(String(Link.TargetPath), ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe')) = 0) and
       (CompareText(String(Link.WorkingDirectory), ExpandConstant('{app}')) = 0) and
       (Pos('"' + Launcher + '"', Arguments) > 0) then
      DeleteFile(FileName);
  except
    Log('Leaving unreadable or unrecognized shortcut unchanged.');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    RemoveOwnedLauncherShortcut(ExpandConstant('{userprograms}\Murmur.lnk'));
    RemoveOwnedLauncherShortcut(ExpandConstant('{userdesktop}\Murmur.lnk'));
    RemoveOwnedLauncherShortcut(ExpandConstant('{userstartup}\Murmur.lnk'));
  end;
end;
