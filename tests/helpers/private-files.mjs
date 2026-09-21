import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function powershell(file, script) {
  const { stdout } = await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';\n$env:PSModulePath=[System.IO.Path]::Combine($PSHOME, 'Modules');\n" + script, 'utf16le').toString('base64')],
    { env: { ...process.env, MURMUR_TEST_ACL_FILE: file }, windowsHide: true, timeout: 10000 });
  return stdout.trim();
}

export async function assertPrivateFile(file) {
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    return;
  }
  const value = JSON.parse(await powershell(file, `
$acl = Get-Acl -LiteralPath $env:MURMUR_TEST_ACL_FILE
$entries = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid=$_.IdentityReference.Value; kind=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights; inherited=$_.IsInherited }
})
@{ protected=$acl.AreAccessRulesProtected; user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries=$entries } | ConvertTo-Json -Depth 4 -Compress
`));
  const expected = new Set([value.user, 'S-1-5-18', 'S-1-5-32-544']);
  assert.equal(value.protected, true, 'private output must not inherit public parent permissions');
  assert.equal(value.entries.length, expected.size);
  for (const entry of value.entries) {
    assert.equal(expected.delete(entry.sid), true, 'only creator, SYSTEM and Administrators may access the private output');
    assert.equal(entry.kind, 'Allow'); assert.equal(entry.rights, 0x1f01ff); assert.equal(entry.inherited, false);
  }
  assert.equal(expected.size, 0);
}

/** Only use with a newly created, test-owned directory. */
export async function allowPublicReadInFixtureDirectory(directory) {
  assert.equal(process.platform, 'win32');
  await powershell(directory, `
$acl = Get-Acl -LiteralPath $env:MURMUR_TEST_ACL_FILE
$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:MURMUR_TEST_ACL_FILE -AclObject $acl
`);
}
