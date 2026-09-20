<#
.SYNOPSIS
Install a prebuilt Murmur runtime as a Windows service for one explicit profile.
.DESCRIPTION
Requires Node.js 22.13.0 or newer and the matching prebuilt murmur-svc.exe.
Run in an elevated terminal as the owner of an already initialized profile. No npm, Go, Git, tray autorun,
client configuration, downloads or machine execution-policy changes are performed.
An exit code of zero confirms local service/identity/database observation only.
Peer pairing, a returned message and an answering AI session are separate checks.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AgentId,
    [Parameter(Mandatory = $true)][Alias('RepoRoot')][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [string]$NodePath,
    [string]$ServiceName = 'MurmurDaemon'
)
$ErrorActionPreference = 'Stop'
$environmentNames = @('DATA_DIR','MURMUR_DATA_DIR','MURMUR_STORE_PATH','NODE_OPTIONS','NODE_PATH','MURMUR_SERVICE_BIN')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$stage = 'preflight'

function Full-Path([string]$value, [string]$label) {
    if ($value -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or $value -match '[\x00-\x1f]') {
        throw "$label must be an absolute path."
    }
    return [IO.Path]::GetFullPath($value)
}
function Find-NodeExecutable {
    $pathValue = [Environment]::GetEnvironmentVariable('PATH', 'Process')
    if ([string]::IsNullOrWhiteSpace($pathValue)) { return $null }
    foreach ($entry in @($pathValue -split ';')) {
        $directory = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
        if (-not $directory) { continue }
        try { $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($directory, 'node.exe')) }
        catch { continue }
        if ([IO.File]::Exists($candidate)) { return $candidate }
    }
    return $null
}
function Invoke-Murmur([string[]]$CommandArgs) {
    $output = & $NodePath --no-warnings $cli @CommandArgs --data-dir $DataDir --service-name $ServiceName --json
    if ($LASTEXITCODE -ne 0) { throw "Murmur $($CommandArgs[0]) failed. Read the CLI error above; no retry was made." }
    try { return (($output -join "`n") | ConvertFrom-Json) }
    catch { throw 'Murmur returned an invalid JSON response. Use matching runtime and service binaries.' }
}
try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
        throw 'Open PowerShell as administrator using the same account that owns the profile, then repeat. Service registration requires elevation.'
    }
    if ($ServiceName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$') { throw 'Invalid service name.' }
    $RuntimeRoot = Full-Path $RuntimeRoot 'RuntimeRoot'
    $DataDir = Full-Path $DataDir 'DataDir'
    $cli = Join-Path $RuntimeRoot 'packages\setup\bin\murmur.mjs'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'RuntimeRoot must contain the extracted, prebuilt runtime. Do not select the ZIP or the bundle parent.' }
    if (-not $NodePath) {
        $NodePath = Find-NodeExecutable
        if (-not $NodePath) { throw 'Node.js is not installed or is not on PATH. Install Node.js 22.13.0 or newer, reopen PowerShell, and try again.' }
    }
    $NodePath = Full-Path $NodePath 'NodePath'
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node moved or is missing. Install Node.js 22.13.0 or newer and reopen PowerShell.' }
    $helper = Join-Path $RuntimeRoot 'bin\murmur-svc.exe'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { $helper = Join-Path $RuntimeRoot 'spikes\windows-service-go\murmur-svc.exe' }
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'The matching prebuilt murmur-svc.exe is missing. Extract the Windows bundle; the portable runtime alone has no service executable.' }

    # Reject occupied names before service changes. The helper checks actual
    # executable/profile ownership again at mutation time; this is not a lock.
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { throw 'This service name already exists. Nothing was changed. Use CLI status with its original profile before deciding to stop or uninstall it.' }
    if (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue) { throw 'A scheduled task has this name. Nothing was changed. Inspect its profile and arrange an explicit migration first.' }
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    $env:DATA_DIR = $DataDir; $env:MURMUR_DATA_DIR = $DataDir; $env:MURMUR_SERVICE_BIN = $helper
    $version = Invoke-Murmur -CommandArgs @('version')
    if ($version.schema -ne 'murmur.version/1') { throw 'The CLI version contract is unavailable. Use a current Windows bundle.' }
    $before = Invoke-Murmur -CommandArgs @('status')
    if ($before.schema -ne 'murmur.status/1' -or $before.service.manager -ne 'windows-service' -or $before.service.state -ne 'stopped') {
        throw 'The service manager did not confirm an available stopped profile. Inspect CLI status before retrying.'
    }
    # Profile initialization belongs to the shared onboarding command. Do not
    # create keys before the native helper has validated the service boundary.
    if ($before.agentId -ne $AgentId) {
        throw 'The selected profile is missing or belongs to another agent. Run the shared CLI init/join first and verify its agentId; nothing was changed here.'
    }
    $stage = 'service installation'
    $installed = Invoke-Murmur -CommandArgs @('service','install')
    if ($installed.schema -ne 'murmur.service/1' -or $installed.action -ne 'install') { throw 'The CLI did not confirm service installation.' }
    $stage = 'fresh observation'
    $status = Invoke-Murmur -CommandArgs @('status')
    if ($status.schema -ne 'murmur.status/1' -or $status.agentId -ne $AgentId -or $status.service.manager -ne 'windows-service' -or $status.service.state -ne 'running' -or -not $status.service.pid -or -not $status.service.observedStorePath) {
        throw 'Fresh status did not confirm the selected identity, running daemon and open database. Inspect CLI status; the service may already be installed.'
    }
    Write-Host "Local service confirmed: $ServiceName; agent $AgentId; daemon PID $($status.service.pid)."
    Write-Host "Profile: $DataDir"
    Write-Host 'Next: exchange private invitation files, configure the client, reload it, and require a returned message. This result does not establish pairing or AI wake.'
    Write-Host 'Use the same --data-dir and --service-name with every CLI command. Service uninstall retains the private profile and logs.'
    Write-Host 'Tray startup/login registration is a separate explicit step; this script does not start or stop tray processes.'
    exit 0
} catch {
    Write-Host "Installation stopped at $stage`: $($_.Exception.Message)" -ForegroundColor Red
    if ($stage -ne 'preflight') { Write-Host 'Earlier steps may have completed. Inspect this profile before retrying; private data is not automatically deleted.' }
    exit 1
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
