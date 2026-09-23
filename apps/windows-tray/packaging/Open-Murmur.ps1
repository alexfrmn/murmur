<# Requires Node.js 22.13.0 or newer. Opens an explicit existing profile using the adjacent prebuilt runtime. #>
[CmdletBinding()]
param(
    [string]$DataDir,
    [string]$NodePath,
    [string]$ServiceName,
    [ValidateSet('en','ru')][string]$Language,
    [switch]$Check
)
$ErrorActionPreference='Stop'
function Quote-Argument([string]$value) {
    return '"' + [regex]::Replace([regex]::Replace($value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1') + '"'
}
function Find-NodeExecutable {
    $pathValue=[Environment]::GetEnvironmentVariable('PATH','Process')
    if([string]::IsNullOrWhiteSpace($pathValue)){return $null}
    foreach($entry in @($pathValue -split ';')) {
        $directory=[Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
        if(-not $directory){continue}
        try{$candidate=[IO.Path]::GetFullPath([IO.Path]::Combine($directory,'node.exe'))}catch{continue}
        if([IO.File]::Exists($candidate)){return $candidate}
    }
    return $null
}
function Start-Bound([string]$file, [string[]]$arguments, [switch]$ReadResult) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$file; $info.Arguments=(($arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.WorkingDirectory=$PSScriptRoot
    $info.EnvironmentVariables.Clear()
    foreach($name in @('SystemRoot','WINDIR','ProgramData','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP','PATH')) {
        $value=[Environment]::GetEnvironmentVariable($name,'Process')
        if($null -ne $value){$info.EnvironmentVariables[$name]=$value}
    }
    if($env:MURMUR_UPDATE_CHECK -eq '0'){$info.EnvironmentVariables['MURMUR_UPDATE_CHECK']='0'}
    $info.EnvironmentVariables['MURMUR_BIN']=$NodePath
    $info.EnvironmentVariables['MURMUR_CLI']=$cli
    $info.EnvironmentVariables['MURMUR_PROFILE']=$DataDir
    if($expectedAgent){$info.EnvironmentVariables['MURMUR_EXPECTED_AGENT']=$expectedAgent}
    if($ServiceName){$info.EnvironmentVariables['MURMUR_SERVICE_NAME']=$ServiceName}
    # A GUI child must not inherit a caller's capture pipes: that keeps the
    # calling PowerShell waiting for output until the tray quits.
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process; $process.StartInfo=$info
    if(-not $process.Start()){throw 'Process did not start.'}
    if(-not $ReadResult){$process.Dispose();return}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(12000)){$process.Kill();throw 'The CLI did not respond in time. Inspect this profile in a terminal.'}
    $text=$stdout.Result; $discard=$stderr.Result
    if($process.ExitCode -ne 0){throw 'Node or the selected profile was not confirmed. Check the runtime and profile with the CLI.'}
    if($text.Length -gt 262144){throw 'CLI response exceeded the limit.'}
    return ($text | ConvertFrom-Json)
}
function Get-LauncherStatePath {
    $local=[Environment]::GetEnvironmentVariable('LOCALAPPDATA','Process')
    if([string]::IsNullOrWhiteSpace($local)){$local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)}
    if([string]::IsNullOrWhiteSpace($local) -or -not [IO.Path]::IsPathRooted($local)){throw 'The per-user application data folder is unavailable.'}
    $local=[IO.Path]::GetFullPath($local)
    Assert-OrdinaryDirectory $local 'The per-user application data folder'
    return [IO.Path]::Combine($local,'Murmur','tray-launch-binding.json')
}
function Assert-OrdinaryDirectory([string]$path,[string]$label,[switch]$AllowMissing) {
    if(-not(Test-Path -LiteralPath $path)){
        if($AllowMissing){return}
        throw "$label is unavailable."
    }
    $item=Get-Item -LiteralPath $path -Force
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "$label must be an ordinary directory."}
}
function Read-LauncherState([string]$path) {
    $parent=[IO.Path]::GetDirectoryName($path)
    Assert-OrdinaryDirectory $parent 'The Murmur per-user data folder' -AllowMissing
    if(-not(Test-Path -LiteralPath $path)){return $null}
    $item=Get-Item -LiteralPath $path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536){throw 'The saved tray launch binding is not a bounded ordinary file.'}
    try{$value=Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json}catch{throw 'The saved tray launch binding is invalid.'}
    $expected=@('agentId','creationDate','dataDir','executable','pid','schema','serviceName','sessionId')
    $actual=@($value.PSObject.Properties.Name | Sort-Object)
    $created=[datetime]::MinValue
    if((Compare-Object $expected $actual) -or $value.schema -ne 'murmur.windows-tray-binding/1' -or
       ($value.pid -isnot [int] -and $value.pid -isnot [long]) -or $value.pid -le 0 -or $value.pid -gt [int]::MaxValue -or
       ($value.sessionId -isnot [int] -and $value.sessionId -isnot [long]) -or $value.sessionId -lt 0 -or $value.sessionId -gt [int]::MaxValue -or
       $value.creationDate -isnot [string] -or $value.executable -isnot [string] -or $value.dataDir -isnot [string] -or
       $value.agentId -isnot [string] -or [string]::IsNullOrWhiteSpace($value.agentId) -or $value.agentId.Length -gt 1024 -or
       -not [datetime]::TryParseExact($value.creationDate,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$created) -or
       -not [IO.Path]::IsPathRooted($value.executable) -or -not [IO.Path]::IsPathRooted($value.dataDir) -or
       ($null -ne $value.serviceName -and ($value.serviceName -isnot [string] -or $value.serviceName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$'))){throw 'The saved tray launch binding has an unknown shape.'}
    $value.executable=[IO.Path]::GetFullPath($value.executable)
    $value.dataDir=[IO.Path]::GetFullPath($value.dataDir)
    return $value
}
function Write-LauncherState([string]$path,$process,[string]$agentId) {
    $parent=[IO.Path]::GetDirectoryName($path)
    if(-not(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Path $parent | Out-Null}
    Assert-OrdinaryDirectory $parent 'The Murmur per-user data folder'
    $value=[ordered]@{
        schema='murmur.windows-tray-binding/1';pid=[int]$process.ProcessId;sessionId=[int]$process.SessionId
        creationDate=([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
        executable=$tray;dataDir=$DataDir;serviceName=$(if($ServiceName){$ServiceName}else{$null});agentId=$agentId
    }
    $temporary=$path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try{
        [IO.File]::WriteAllText($temporary,(ConvertTo-Json $value -Compress)+"`n",(New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $path -Force
    }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
}
function Get-ExactTrayProcesses {
    $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
    return @(Get-CimInstance Win32_Process -Filter "Name='murmur-tray.exe'" | Where-Object {
        if(-not $_.ExecutablePath -or [int]$_.SessionId -ne $session){return $false}
        try{return [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $tray}catch{return $false}
    })
}
function Get-RecordedBindingProcess($state) {
    if($null -eq $state){return $null}
    $candidate=@(Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)")
    if($candidate.Count -gt 1){throw 'The saved tray process identity is ambiguous.'}
    if($candidate.Count -eq 0){return $null}
    if(-not $candidate[0].ExecutablePath){throw 'The saved tray process is still present but its identity could not be verified.'}
    try{$executable=[IO.Path]::GetFullPath([string]$candidate[0].ExecutablePath);$created=([datetime]$candidate[0].CreationDate).ToUniversalTime().ToString('o')}catch{
        throw 'The saved tray process is still present but its identity could not be verified.'
    }
    if($executable -ieq $state.executable -and [int]$candidate[0].SessionId -eq [int]$state.sessionId -and $created -ceq $state.creationDate){return $candidate[0]}
    return $null
}
function Assert-LauncherStateTarget($state,$recordedProcess,[string]$agentId) {
    if($null -eq $state){return}
    $serviceMatches=if($ServiceName){$state.serviceName -ceq $ServiceName}else{$null -eq $state.serviceName}
    $targetMatches=$state.executable -ieq $tray -and $state.dataDir -ieq $DataDir -and $serviceMatches -and $state.agentId -ceq $agentId
    if(-not $targetMatches -and $null -ne $recordedProcess){
        throw 'The saved launcher belongs to a running Murmur bundle or profile. Quit that tray and remove its old shortcuts before opening this selection.'
    }
}
function Assert-MatchingLauncherState($state,$process,[string]$agentId) {
    if($null -eq $state){throw 'This tray predates the saved launch binding. Quit it from its menu, then open Murmur again.'}
    $created=([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
    $serviceMatches=if($ServiceName){$state.serviceName -ceq $ServiceName}else{$null -eq $state.serviceName}
    if($state.pid -ne [int]$process.ProcessId -or $state.sessionId -ne [int]$process.SessionId -or
       $state.sessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $state.creationDate -cne $created -or
       $state.executable -ine $tray -or $state.dataDir -ine $DataDir -or -not $serviceMatches -or $state.agentId -cne $agentId){
        throw 'The running tray belongs to another saved launch binding. Quit it from its menu before opening this profile.'
    }
}
function Stop-VerifiedTrayProcess($process) {
    $current=@(Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$process.ProcessId)")
    if($current.Count -ne 1 -or -not $current[0].ExecutablePath){return}
    $created=([datetime]$current[0].CreationDate).ToUniversalTime().ToString('o')
    if([IO.Path]::GetFullPath([string]$current[0].ExecutablePath) -ine $tray -or
       [int]$current[0].SessionId -ne [int]$process.SessionId -or $created -cne ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')){return}
    $owned=Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue
    if($owned){$owned.Kill();$owned.WaitForExit()}
}
function Initialize-TrayActivationApi {
    if('MurmurTrayActivation' -as [type]){return}
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class MurmurTrayActivation {
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", SetLastError=true)] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool AllowSetForegroundWindow(uint processId);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessageW(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr OpenEventW(uint desiredAccess, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    private static extern void SHChangeNotify(int eventId, uint flags, [MarshalAs(UnmanagedType.LPWStr)] string item1, IntPtr item2);
    public static IntPtr[] Find(uint processId, string className) {
        var found = new List<IntPtr>();
        if (!EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
            uint owner; if (GetWindowThreadProcessId(hwnd, out owner) == 0 || owner != processId) return true;
            var name = new StringBuilder(256);
            if (GetClassNameW(hwnd, name, name.Capacity) > 0 && String.Equals(name.ToString(), className, StringComparison.Ordinal)) found.Add(hwnd);
            return true;
        }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return found.ToArray();
    }
    private static IntPtr[] FindGuide(uint processId) {
        var found = new List<IntPtr>();
        if (!EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
            uint owner; if (GetWindowThreadProcessId(hwnd, out owner) == 0 || owner != processId || !IsWindowVisible(hwnd)) return true;
            var name = new StringBuilder(256); var title = new StringBuilder(256);
            if (GetClassNameW(hwnd, name, name.Capacity) > 0 && String.Equals(name.ToString(), "#32770", StringComparison.Ordinal) &&
                GetWindowTextW(hwnd, title, title.Capacity) > 0 && String.Equals(title.ToString(), "Murmur", StringComparison.Ordinal)) found.Add(hwnd);
            return true;
        }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return found.ToArray();
    }
    public static void Open(IntPtr hwnd, uint processId, string className) {
        const uint WM_USER = 0x0400, WM_RBUTTONUP = 0x0205;
        uint owner;
        var name = new StringBuilder(256);
        if (GetWindowThreadProcessId(hwnd, out owner) == 0 || owner != processId ||
            GetClassNameW(hwnd, name, name.Capacity) == 0 || !String.Equals(name.ToString(), className, StringComparison.Ordinal))
            throw new InvalidOperationException("The tray control window changed before activation.");
        var guides = FindGuide(processId);
        if (guides.Length > 1) throw new InvalidOperationException("Multiple Murmur guide windows matched the running tray; activation was refused.");
        AllowSetForegroundWindow(processId);
        if (guides.Length == 1) {
            ShowWindow(guides[0], 9);
            if (!SetForegroundWindow(guides[0])) throw new InvalidOperationException("The Murmur guide is open, but Windows did not allow it to be brought to the foreground.");
            return;
        }
        if (!PostMessageW(hwnd, WM_USER + 1, UIntPtr.Zero, new IntPtr((int)WM_RBUTTONUP))) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void SignalGuideReady(uint processId) {
        var handle = OpenEventW(0x0002, false, "Local\\MurmurGuideReady-" + processId);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { if (!SetEvent(handle)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        finally { CloseHandle(handle); }
    }
    public static void ShortcutCreated(string path) { SHChangeNotify(0x00000002, 0x00001005, path, IntPtr.Zero); }
    public static void ShortcutDeleted(string path) { SHChangeNotify(0x00000004, 0x00001005, path, IntPtr.Zero); }
}
'@
}
function Get-TrayWindow([int]$processId) {
    Initialize-TrayActivationApi
    $deadline=[datetime]::UtcNow.AddSeconds(8)
    do{
        $windows=@([MurmurTrayActivation]::Find([uint32]$processId,'SystrayClass'))
        if($windows.Count -gt 1){throw 'Multiple tray control windows matched the saved process; activation was refused.'}
        if($windows.Count -eq 1){return $windows[0]}
        Start-Sleep -Milliseconds 100
    }while([datetime]::UtcNow -lt $deadline)
    throw 'The running tray did not expose its controls in time.'
}
function Get-ShortcutPlan {
    $programs=[Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    $desktop=[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
    foreach($folder in @($programs,$desktop)){
        if([string]::IsNullOrWhiteSpace($folder) -or -not [IO.Path]::IsPathRooted($folder)){throw 'A per-user shortcut folder is unavailable.'}
        Assert-OrdinaryDirectory $folder 'A per-user shortcut folder'
    }
    $powershell=(Get-Item -LiteralPath (Join-Path $PSHOME 'powershell.exe')).FullName
    $parts=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-NodePath',$NodePath,'-DataDir',$DataDir)
    if($ServiceName){$parts+=@('-ServiceName',$ServiceName)}
    $arguments=(($parts | ForEach-Object { Quote-Argument $_ }) -join ' ')
    $description='Open Murmur controls (managed by Murmur)'
    $icon=$iconPath+',0'
    $shell=New-Object -ComObject WScript.Shell
    $plan=@()
    foreach($path in @((Join-Path $programs 'Murmur.lnk'),(Join-Path $desktop 'Murmur.lnk'))){
        $exists=Test-Path -LiteralPath $path
        if($exists){
            $item=Get-Item -LiteralPath $path -Force
            if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 1048576){throw "Shortcut location is occupied by an unmanaged item: $path. Remove the old shortcut before opening this selection."}
            try{$link=$shell.CreateShortcut($path)}catch{throw "Shortcut location is occupied by an unreadable item: $path. Remove the old shortcut before opening this selection."}
            $savedIcon=([string]$link.IconLocation) -replace ',\s*([0-9]+)$',',$1'
            if($link.TargetPath -ine $powershell -or $link.Arguments -cne $arguments -or $link.WorkingDirectory -ine $PSScriptRoot -or
               $link.Description -cne $description -or $savedIcon -ine $icon){throw "Shortcut location is occupied by another target: $path. Remove the old shortcut before opening this selection."}
        }
        $plan+=@{Path=$path;Exists=$exists;Target=$powershell;Arguments=$arguments;WorkingDirectory=$PSScriptRoot;Description=$description;Icon=$icon}
    }
    return @($plan)
}
function Install-MissingShortcuts($plan) {
    $created=@();$shell=New-Object -ComObject WScript.Shell
    try{
        foreach($entry in $plan){
            if($entry.Exists){continue}
            $temporary=[IO.Path]::Combine([IO.Path]::GetDirectoryName($entry.Path),'.murmur-'+[guid]::NewGuid().ToString('N')+'.tmp.lnk')
            $temporaryBytes=$null
            try{
                $link=$shell.CreateShortcut($temporary)
                $link.TargetPath=$entry.Target;$link.Arguments=$entry.Arguments;$link.WorkingDirectory=$entry.WorkingDirectory
                $link.Description=$entry.Description;$link.IconLocation=$entry.Icon;$link.WindowStyle=1;$link.Save()
                $temporaryItem=Get-Item -LiteralPath $temporary -Force
                if($temporaryItem.PSIsContainer -or ($temporaryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $temporaryItem.Length -gt 1048576){throw "The staged shortcut is invalid: $($entry.Path)"}
                $temporaryBytes=[Convert]::ToBase64String([IO.File]::ReadAllBytes($temporary))
                try{[IO.File]::Move($temporary,$entry.Path)}catch{throw "Shortcut location became occupied before it could be created: $($entry.Path)"}
                $created+=@([pscustomobject]@{Path=$entry.Path;Bytes=$temporaryBytes})
                $temporary=$null
            }finally{
                if($temporary -and (Test-Path -LiteralPath $temporary -PathType Leaf)){
                    try{
                        $actual=[Convert]::ToBase64String([IO.File]::ReadAllBytes($temporary))
                        if($null -ne $temporaryBytes -and $actual -ceq $temporaryBytes){Remove-Item -LiteralPath $temporary -Force}
                    }catch{}
                }
            }
        }
        return @($created)
    }catch{
        Remove-CreatedShortcuts $created
        throw
    }
}
function Test-ExactCreatedShortcut($created) {
    if($null -eq $created -or -not(Test-Path -LiteralPath $created.Path -PathType Leaf)){return $false}
    try{
        $item=Get-Item -LiteralPath $created.Path -Force
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 1048576){return $false}
        return [Convert]::ToBase64String([IO.File]::ReadAllBytes($created.Path)) -ceq $created.Bytes
    }catch{return $false}
}
function Notify-CreatedShortcuts($paths) {
    foreach($created in @($paths)){
        if(-not(Test-ExactCreatedShortcut $created)){continue}
        try{Initialize-TrayActivationApi;[MurmurTrayActivation]::ShortcutCreated([string]$created.Path)}catch{}
    }
}
function Remove-CreatedShortcuts($paths) {
    foreach($created in @($paths)){
        if(-not(Test-ExactCreatedShortcut $created)){continue}
        try{
            $path=[string]$created.Path
            Remove-Item -LiteralPath $path -Force
            if(-not(Test-Path -LiteralPath $path)){Initialize-TrayActivationApi;[MurmurTrayActivation]::ShortcutDeleted($path)}
        }catch{}
    }
}
try {
    $runtime=Join-Path $PSScriptRoot 'runtime'
    $cli=Join-Path $runtime 'packages\setup\bin\murmur.mjs'
    $tray=Join-Path $PSScriptRoot 'murmur-tray.exe'
    $iconPath=Join-Path $PSScriptRoot 'murmur.ico'
    foreach($file in @($cli,$tray,$iconPath)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'Extract the complete Windows bundle first: tray, launcher, icon and runtime must remain together.'}}
    $iconItem=Get-Item -LiteralPath $iconPath -Force
    if(($iconItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $iconItem.Length -lt 22 -or $iconItem.Length -gt 1048576){throw 'The adjacent murmur.ico is not a bounded ordinary icon file.'}
    $iconHeader=[IO.File]::ReadAllBytes($iconPath)
    if($iconHeader[0] -ne 0 -or $iconHeader[1] -ne 0 -or $iconHeader[2] -ne 1 -or $iconHeader[3] -ne 0 -or $iconHeader[4] -lt 1 -or $iconHeader[5] -ne 0){throw 'The adjacent murmur.ico is invalid.'}
    if(-not $NodePath){
        $NodePath=Find-NodeExecutable
        if(-not $NodePath){throw 'Node.js is not installed or is not on PATH. Install Node.js 22.13.0 or newer, reopen PowerShell, and try again.'}
    }
    if(-not [IO.Path]::IsPathRooted($NodePath) -or -not(Test-Path -LiteralPath $NodePath -PathType Leaf)){throw 'Select an installed Node executable using -NodePath.'}
    $NodePath=(Get-Item -LiteralPath $NodePath).FullName
    if(-not $DataDir){
        if($Check){throw '-Check requires an explicit -DataDir; no dialog is opened.'}
        # No profile named: open the tray itself. It finds the last or default profile, or says Murmur
        # is not set up and offers to connect to a colleague. A folder dialog helps nobody here.
        if(@(Get-ExactTrayProcesses).Count -eq 0){Start-Process -FilePath $tray -WorkingDirectory $PSScriptRoot}
        exit 0
    }
    if(-not [IO.Path]::IsPathRooted($DataDir) -or -not(Test-Path -LiteralPath $DataDir -PathType Container)){throw 'Select an existing absolute profile folder. Initialize it with the CLI first.'}
    $DataDir=(Get-Item -LiteralPath $DataDir).FullName
    if($ServiceName -and $ServiceName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$'){throw 'Invalid service name.'}
    $version=Start-Bound -file $NodePath -arguments @('--no-warnings',$cli,'version','--json') -ReadResult
    if($version.schema -ne 'murmur.version/1'){throw 'Use the matching current CLI runtime.'}
    $languageArguments=@()
    if($PSBoundParameters.ContainsKey('Language')){$languageArguments=@('--lang',$Language)}
    $probe=Start-Bound -file $tray -arguments (@('--check-profile')+$languageArguments) -ReadResult
    if($probe.schema -ne 'murmur.tray-probe/1' -or -not $probe.agentId){throw 'The tray could not confirm a profile identity.'}
    $expectedAgent=$probe.agentId
    if($Check){@{schema='murmur.windows-launcher/1';version=$version.version;agentId=$probe.agentId;dataDir=$DataDir;probe=$probe} | ConvertTo-Json -Depth 20;exit 0}
    # All shortcut and binding validation completes before a process, state or link changes.
    $statePath=Get-LauncherStatePath
    $state=Read-LauncherState $statePath
    $shortcutPlan=Get-ShortcutPlan
    $recordedProcess=Get-RecordedBindingProcess $state
    Assert-LauncherStateTarget $state $recordedProcess $probe.agentId
    $running=@(Get-ExactTrayProcesses)
    if($running.Count -gt 1){throw 'Multiple matching tray processes are running; activation was refused.'}
    if($null -ne $recordedProcess -and ([int]$recordedProcess.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
       $running.Count -ne 1 -or [int]$running[0].ProcessId -ne [int]$recordedProcess.ProcessId)){
        throw 'The saved tray is running but cannot be activated safely from this Windows session.'
    }
    if($running.Count -eq 1){
        Assert-MatchingLauncherState $state $running[0] $probe.agentId
        $window=Get-TrayWindow ([int]$running[0].ProcessId)
        $created=@(Install-MissingShortcuts $shortcutPlan)
        try{[MurmurTrayActivation]::Open($window,[uint32]$running[0].ProcessId,'SystrayClass')}catch{Remove-CreatedShortcuts $created;throw}
        Notify-CreatedShortcuts $created
        Write-Host "Murmur controls opened for $($probe.agentId). The service continues independently."
        exit 0
    }
    $process=$null;$created=@()
    try{
        $launched=Start-Bound -file $tray -arguments (@('--launch')+$languageArguments) -ReadResult
        if($launched.schema -ne 'murmur.tray-launch/1' -or
           ($launched.pid -isnot [int] -and $launched.pid -isnot [long]) -or $launched.pid -le 0 -or $launched.pid -gt [int]::MaxValue){throw 'Tray launch was not confirmed.'}
        $deadline=[datetime]::UtcNow.AddSeconds(8)
        do{
            $candidate=@(Get-CimInstance Win32_Process -Filter "ProcessId=$($launched.pid)")
            if($candidate.Count -gt 1){throw 'The launched tray process identity was ambiguous.'}
            if($candidate.Count -eq 1 -and $candidate[0].ExecutablePath -and [IO.Path]::GetFullPath([string]$candidate[0].ExecutablePath) -ieq $tray){$process=$candidate[0];break}
            Start-Sleep -Milliseconds 100
        }while([datetime]::UtcNow -lt $deadline)
        if($null -eq $process){throw 'The launched tray process could not be verified.'}
        if([int]$process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'The launched tray is in another Windows session.'}
        $null=Get-TrayWindow ([int]$process.ProcessId)
        $created=@(Install-MissingShortcuts $shortcutPlan)
        Write-LauncherState $statePath $process $probe.agentId
        [MurmurTrayActivation]::SignalGuideReady([uint32]$process.ProcessId)
    }catch{
        Remove-CreatedShortcuts $created
        if($null -ne $process){Stop-VerifiedTrayProcess $process}
        throw
    }
    Notify-CreatedShortcuts $created
    Write-Host "Murmur opened for $($probe.agentId). The service continues independently."
    exit 0
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
