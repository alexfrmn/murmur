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

[Setup]
AppId={{427756A9-E238-4E87-B289-8DA6AD302E8C}
AppName=Murmur
AppVersion={#ReleaseVersion}
AppPublisher=Murmur
DefaultDirName={localappdata}\Programs\Murmur
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
DisableWelcomePage=no
UninstallDisplayIcon={app}\murmur-tray.exe
OutputDir={#OutputDir}
OutputBaseFilename=Murmur-{#ReleaseVersion}-windows-x64-setup
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
Name: "{userprograms}\Murmur\Murmur"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Open-Murmur.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\murmur-tray.exe"; Comment: "Open Murmur"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Open-Murmur.ps1"""; Description: "{cm:LaunchProgram,Murmur}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

; No profile directories, SCM operations, wildcard uninstall deletion, or user
; client configuration are included. Inno removes only its installed payload.
; The launcher alone owns Desktop/Startup/flat Programs links because only it
; knows the selected profile and service. Installer ownership agreed with Claude.

[Code]
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
