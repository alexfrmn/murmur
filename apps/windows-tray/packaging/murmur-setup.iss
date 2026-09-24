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
  #define MarkerId "Murmur.CodexWin.Installer.Acceptance"
  #define InstallerName "Murmur CodexWin Installer Test"
  #define InstallFolder "Murmur-codex-win-acceptance-only"
#else
  #define InstallerId "{{427756A9-E238-4E87-B289-8DA6AD302E8C}"
  #define MarkerId "{427756A9-E238-4E87-B289-8DA6AD302E8C}"
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
; Use the verified bundle's shared capability check and engines.node policy.
Source: "{#BundleDir}\runtime\scripts\runtime-capability.mjs"; Flags: dontcopy
Source: "{#BundleDir}\runtime\package.json"; DestName: "murmur-node-policy.json"; Flags: dontcopy
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "startup"; Description: "{cm:StartupTask}"
Name: "desktop"; Description: "{cm:DesktopTask}"; Flags: unchecked

[CustomMessages]
english.StartupTask=Start Murmur when I sign in to Windows
russian.StartupTask=Запускать Murmur при входе в Windows
english.DesktopTask=Create a desktop shortcut
russian.DesktopTask=Создать ярлык на рабочем столе
english.ShortcutReplace=Found a shortcut from a previous Murmur installation — replace it?
russian.ShortcutReplace=Найден ярлык прошлой установки Murmur — заменить?
english.ShortcutDeclined=The shortcut was kept. Allow replacement to continue installing Murmur.
russian.ShortcutDeclined=Ярлык сохранён. Разрешите замену, чтобы продолжить установку Murmur.
english.ShortcutSilentConflict=A shortcut already exists. Remove /SHORTCUTCONFLICT=fail to allow replacement, or run the installer interactively.
russian.ShortcutSilentConflict=Ярлык уже существует. Уберите /SHORTCUTCONFLICT=fail, чтобы разрешить замену, или запустите мастер установки.
english.NodeRequired=Murmur needs Node.js 22.13.0 or newer. A compatible installation was not found. Open the official download page?%n%nYou can finish installing Murmur now. After installing Node.js, reopen Murmur to continue setup.
russian.NodeRequired=Для Murmur нужен Node.js 22.13.0 или новее. Подходящая установка не найдена. Открыть официальную страницу скачивания?%n%nУстановку Murmur можно завершить сейчас. После установки Node.js снова откройте Murmur, чтобы продолжить настройку.
english.NodeDownloadFailed=Could not open the browser. Download Node.js from https://nodejs.org/en/download, then reopen Murmur.
russian.NodeDownloadFailed=Не удалось открыть браузер. Скачайте Node.js с https://nodejs.org/en/download, затем снова откройте Murmur.

[Icons]
Name: "{userprograms}\{#InstallerName}\Murmur"; Filename: "{app}\murmur-tray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\murmur-tray.exe"; Comment: "Open Murmur controls (managed by Murmur)"
Name: "{userstartup}\{#InstallerName}"; Filename: "{app}\murmur-tray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\murmur-tray.exe"; Comment: "Open Murmur controls (managed by Murmur)"; Tasks: startup; Flags: runminimized
Name: "{userdesktop}\{#InstallerName}"; Filename: "{app}\murmur-tray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\murmur-tray.exe"; Comment: "Open Murmur controls (managed by Murmur)"; Tasks: desktop

[UninstallDelete]
Type: files; Name: "{app}\murmur-install.json"

[Run]
Filename: "{app}\murmur-tray.exe"; Description: "{cm:LaunchProgram,Murmur}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runhidden; Check: NotRestarted

; No profile directories, SCM operations, wildcard uninstall deletion, or user
; client configuration are included. Inno removes only its installed payload.
; Setup owns installed shortcuts. The marker asks the portable launcher to leave them alone.

[Code]
var
  RestartTray: Boolean;
  TrayRestarted: Boolean;
  NodeNoticeShown: Boolean;

function SetEnvironmentVariable(Name, Value: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function CompatibleNode(): Boolean;
var
  NodePath, CheckDir, OldOptions: String;
  ExitCode: Integer;
begin
  Result := False;
  NodePath := FileSearch('node.exe', GetEnv('PATH'));
  if NodePath = '' then exit;
  CheckDir := ExpandConstant('{tmp}\murmur-node-check');
  if not ForceDirectories(CheckDir + '\scripts') then exit;
  ExtractTemporaryFile('runtime-capability.mjs');
  ExtractTemporaryFile('murmur-node-policy.json');
  if not FileCopy(ExpandConstant('{tmp}\runtime-capability.mjs'), CheckDir + '\scripts\runtime-capability.mjs', False) then exit;
  if not FileCopy(ExpandConstant('{tmp}\murmur-node-policy.json'), CheckDir + '\package.json', False) then exit;
  if not SaveStringToFile(CheckDir + '\check.mjs',
    'import { checkRuntime } from "./scripts/runtime-capability.mjs";' + #13#10 +
    'try { await checkRuntime(); } catch { process.exitCode = 1; }', False) then exit;
  OldOptions := GetEnv('NODE_OPTIONS');
  if not SetEnvironmentVariable('NODE_OPTIONS', '') then exit;
  try
    Result := Exec(NodePath, '"' + CheckDir + '\check.mjs"', CheckDir,
      SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
  finally
    SetEnvironmentVariable('NODE_OPTIONS', OldOptions);
  end;
end;

procedure CheckNodeRequirement();
var
  ErrorCode: Integer;
begin
  if NodeNoticeShown then exit;
  NodeNoticeShown := True;
  if CompatibleNode() then exit;
  if WizardSilent then begin
    Log('Compatible Node.js not found; setup can finish, but Murmur needs Node.js to complete first-run setup.');
    exit;
  end;
  if MsgBox(CustomMessage('NodeRequired'), mbConfirmation, MB_YESNO) = IDYES then
    if not ShellExec('open', 'https://nodejs.org/en/download', '', '', SW_SHOWNORMAL,
      ewNoWait, ErrorCode) then
      MsgBox(CustomMessage('NodeDownloadFailed'), mbInformation, MB_OK);
end;

function NotRestarted(): Boolean;
begin
  Result := not TrayRestarted;
end;

function StopInstalledTray(): String;
var
  Locator, Wmi, Processes, Process: Variant;
  I, Attempt: Integer;
  Target: String;
  Found: Boolean;
begin
  Result := '';
  Target := ExpandConstant('{app}\murmur-tray.exe');
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Wmi := Locator.ConnectServer('.', 'root\cimv2');
    for Attempt := 0 to 50 do begin
      Found := False;
      Processes := Wmi.ExecQuery('SELECT * FROM Win32_Process WHERE Name = ''murmur-tray.exe''');
      for I := 0 to Processes.Count - 1 do begin
        Process := Processes.ItemIndex(I);
        if not VarIsNull(Process.ExecutablePath) then begin
          if CompareText(String(Process.ExecutablePath), Target) = 0 then begin
            Found := True;
            RestartTray := True;
            if Attempt = 0 then begin
              Log('Stopping tray from this installation only.');
              if Process.Terminate(0) <> 0 then RaiseException('Tray refused termination');
            end;
          end;
        end;
      end;
      if not Found then exit;
      Sleep(100);
    end;
    RaiseException('Tray did not exit');
  except
    Result := 'Close Murmur using its tray menu, then try again. The installed tray could not be closed safely.';
  end;
end;

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

function IsOwnedShortcut(const FileName: String): Boolean;
var
  Shell, Link: Variant;
  Launcher, Arguments: String;
  OldTarget, DirectTarget, Managed: Boolean;
begin
  Result := False;
  if not FileExists(FileName) then exit;
  try
    Shell := CreateOleObject('WScript.Shell');
    Link := Shell.CreateShortcut(FileName);
    Launcher := ExpandConstant('{app}\Open-Murmur.ps1');
    Arguments := Link.Arguments;
    OldTarget := ((CompareText(String(Link.TargetPath), ExpandConstant('{win}\System32\WindowsPowerShell\v1.0\powershell.exe')) = 0) or
      (CompareText(String(Link.TargetPath), ExpandConstant('{win}\SysWOW64\WindowsPowerShell\v1.0\powershell.exe')) = 0)) and
      ((Pos(Lowercase('-File "' + Launcher + '"'), Lowercase(Arguments)) > 0) or
       (Pos(Lowercase('"-File" "' + Launcher + '"'), Lowercase(Arguments)) > 0));
    DirectTarget := (CompareText(String(Link.TargetPath), ExpandConstant('{app}\murmur-tray.exe')) = 0) and
      (Arguments = '');
    Managed := (String(Link.Description) = 'Open Murmur controls (managed by Murmur)') or
      (DirectTarget and (CompareText(FileName, ExpandConstant('{userprograms}\{#InstallerName}\Murmur.lnk')) = 0) and
       (String(Link.Description) = 'Open Murmur'));
    Result := Managed and (CompareText(String(Link.WorkingDirectory), ExpandConstant('{app}')) = 0) and
      (OldTarget or DirectTarget);
  except
    Log('Leaving unreadable or unrecognized shortcut unchanged.');
  end;
end;

function ShortcutConflict(const FileName: String): String;
begin
  Result := '';
  if not FileExists(FileName) then exit;
  if IsOwnedShortcut(FileName) then exit;
  if WizardSilent then begin
    { Explicit unattended policy: return PrepareToInstall failure (exit 7) only
      when requested. Otherwise Inno replaces the selected shortcut on install. }
    if CompareText(ExpandConstant('{param:SHORTCUTCONFLICT|replace}'), 'fail') = 0 then
      Result := CustomMessage('ShortcutSilentConflict');
    exit;
  end;
  if MsgBox(CustomMessage('ShortcutReplace') + #13#10#13#10 + FileName,
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES then
    Result := CustomMessage('ShortcutDeclined');
  { Do not delete anything during preflight. [Icons] replaces it only after all
    dependency checks pass and the person proceeds with installation. }
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  CheckNodeRequirement();
  Result := ServiceDependencyError();
  if Result = '' then Result := ShortcutConflict(ExpandConstant('{userprograms}\{#InstallerName}\Murmur.lnk'));
  if (Result = '') and WizardIsTaskSelected('startup') then Result := ShortcutConflict(ExpandConstant('{userstartup}\{#InstallerName}.lnk'));
  if (Result = '') and WizardIsTaskSelected('desktop') then Result := ShortcutConflict(ExpandConstant('{userdesktop}\{#InstallerName}.lnk'));
  if Result = '' then Result := StopInstalledTray();
end;

function InitializeUninstall(): Boolean;
var
  Reason: String;
begin
  Reason := ServiceDependencyError();
  if Reason = '' then Reason := StopInstalledTray();
  Result := Reason = '';
  if not Result then begin
    Log(Reason);
    SuppressibleMsgBox(Reason, mbError, MB_OK, IDOK);
  end;
end;

procedure RemoveOwnedLauncherShortcut(const FileName: String);
begin
  if IsOwnedShortcut(FileName) then DeleteFile(FileName);
end;
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    if not SaveStringToFile(ExpandConstant('{app}\murmur-install.json'),
      '{"installer":"setup","appId":"{#MarkerId}","version":"{#ReleaseVersion}"}' + #13#10, False) then
      RaiseException('Could not record installer ownership');
    RemoveOwnedLauncherShortcut(ExpandConstant('{userprograms}\{#InstallerName}.lnk'));
    if not WizardIsTaskSelected('startup') then RemoveOwnedLauncherShortcut(ExpandConstant('{userstartup}\{#InstallerName}.lnk'));
    if not WizardIsTaskSelected('desktop') then RemoveOwnedLauncherShortcut(ExpandConstant('{userdesktop}\{#InstallerName}.lnk'));
    if RestartTray then begin
      TrayRestarted := Exec(ExpandConstant('{app}\murmur-tray.exe'), '', ExpandConstant('{app}'), SW_HIDE, ewNoWait, ExitCode);
      if not TrayRestarted then RaiseException('Murmur was updated but its tray could not restart');
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    RemoveOwnedLauncherShortcut(ExpandConstant('{userprograms}\{#InstallerName}.lnk'));
    RemoveOwnedLauncherShortcut(ExpandConstant('{userdesktop}\{#InstallerName}.lnk'));
    RemoveOwnedLauncherShortcut(ExpandConstant('{userstartup}\{#InstallerName}.lnk'));
  end;
end;
