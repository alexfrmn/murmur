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
try {
    $runtime=Join-Path $PSScriptRoot 'runtime'
    $cli=Join-Path $runtime 'packages\setup\bin\murmur.mjs'
    $tray=Join-Path $PSScriptRoot 'murmur-tray.exe'
    foreach($file in @($cli,$tray)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'Extract the complete Windows bundle first: tray, launcher and runtime must remain together.'}}
    if(-not $NodePath){
        $nodeCommand=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
        if(-not $nodeCommand){throw 'Node.js is not installed or is not on PATH. Install Node.js 22.13.0 or newer, reopen PowerShell, and try again.'}
        $NodePath=$nodeCommand.Source
    }
    if(-not [IO.Path]::IsPathRooted($NodePath) -or -not(Test-Path -LiteralPath $NodePath -PathType Leaf)){throw 'Select an installed Node executable using -NodePath.'}
    $NodePath=(Get-Item -LiteralPath $NodePath).FullName
    if(-not $DataDir){
        if($Check){throw '-Check requires an explicit -DataDir; no dialog is opened.'}
        Add-Type -AssemblyName System.Windows.Forms
        $picker=New-Object System.Windows.Forms.FolderBrowserDialog
        $picker.Description='Select the existing Murmur profile created by CLI init/join.'
        $picker.ShowNewFolderButton=$false
        if($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){exit 0}
        $DataDir=$picker.SelectedPath
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
    # Do not stop an existing app or replace its selected profile implicitly.
    $running=Get-CimInstance Win32_Process -Filter "Name='murmur-tray.exe'" | Where-Object { $_.ExecutablePath -eq $tray }
    if($running){throw 'This tray is already running. Quit it from its menu before choosing another profile.'}
    $launched=Start-Bound -file $tray -arguments (@('--launch')+$languageArguments) -ReadResult
    if($launched.schema -ne 'murmur.tray-launch/1' -or $launched.pid -le 0){throw 'Tray launch was not confirmed.'}
    Write-Host "Murmur opened for $($probe.agentId). The service continues independently."
    exit 0
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
