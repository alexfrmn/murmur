import { execFile } from 'node:child_process';
import { lstat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { sameClientFileIdentity } from './file-identity.js';

const exec = promisify(execFile);
const protect = `
$ErrorActionPreference = 'Stop'
$file = $env:MURMUR_SETUP_PRIVATE_FILE
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($user, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$security = New-Object System.Security.AccessControl.FileSecurity
$security.SetAccessRuleProtection($true, $false)
foreach ($id in $allowed) {
  $sid = New-Object System.Security.Principal.SecurityIdentifier($id)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $security.AddAccessRule($rule)
}
Set-Acl -LiteralPath $file -AclObject $security
$actual = Get-Acl -LiteralPath $file
if (!$actual.AreAccessRulesProtected) { throw 'unprotected ACL' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $allowed.Count) { throw 'unexpected ACL entries' }
foreach ($rule in $rules) {
  if ($allowed -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow' -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'unexpected ACL' }
}
`;

/** Protect a newly created, still-empty setup output before writing credentials. */
export async function protectPrivateFile(file: string, handle: FileHandle): Promise<void> {
  if (process.platform !== 'win32') return;
  const opened = await handle.stat({ bigint: true });
  const before = await lstat(file, { bigint: true });
  if (!opened.isFile() || opened.size !== 0n || !before.isFile() || !sameClientFileIdentity(before, opened)) {
    throw new Error('private-file.target-invalid');
  }
  try {
    await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protect, 'utf16le').toString('base64')],
      { env: { ...process.env, MURMUR_SETUP_PRIVATE_FILE: file }, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch { throw new Error('private-file.windows-acl-failed'); }
  const after = await lstat(file, { bigint: true });
  if (!after.isFile() || !sameClientFileIdentity(after, opened)) throw new Error('private-file.target-changed');
}
