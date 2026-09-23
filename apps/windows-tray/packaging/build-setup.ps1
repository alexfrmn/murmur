param(
    [Parameter(Mandatory=$true)][string]$BundleDir,
    [Parameter(Mandatory=$true)][string]$OutputDir,
    [Parameter(Mandatory=$true)][string]$Compiler,
    [string]$NodePath = 'node',
    [string]$BundleChecker = (Join-Path $PSScriptRoot '..\..\..\..\scripts\check-windows-bundle.mjs')
)
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path -LiteralPath $BundleDir).Path.TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputDir).TrimEnd('\')
if ($output -ieq $bundle -or $output.StartsWith($bundle+'\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer output must be outside the verified bundle.'
}
$compilerPath = (Resolve-Path -LiteralPath $Compiler).Path
$checker = (Resolve-Path -LiteralPath $BundleChecker).Path
# The existing release checker verifies inventory hashes and native provenance.
& $NodePath $checker $bundle
if ($LASTEXITCODE -ne 0) { throw 'Windows bundle verification failed.' }
$manifest = Get-Content -LiteralPath (Join-Path $bundle 'release-manifest.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.declaredVersion
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Installer needs a stable numeric release version.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
& $compilerPath "/DBundleDir=$bundle" "/DReleaseVersion=$version" "/DOutputDir=$output" (Join-Path $PSScriptRoot 'murmur-setup.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }
$artifact = Join-Path $output "Murmur-$version-windows-x64-setup.exe"
$proof = [ordered]@{
    schema = 'murmur.windows-installer/1'
    version = $version
    bundleSourceCommit = $manifest.sourceCommit
    bundleManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $bundle 'release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    installer = [IO.Path]::GetFileName($artifact)
    sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    signed = $false
}
$proof | ConvertTo-Json | Set-Content -LiteralPath ($artifact+'.json') -Encoding UTF8
$proof | ConvertTo-Json
