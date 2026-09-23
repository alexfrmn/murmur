import { execFile } from 'node:child_process';
import { lstat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { sameClientFileIdentity } from './file-identity.js';

const exec = promisify(execFile);
const protect = `
$ErrorActionPreference = 'Stop'
# Node can inherit PowerShell 7's module paths when launched by a CI runner or
# terminal. Only load modules belonging to this Windows PowerShell 5.1 process.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
$file = $env:MURMUR_SETUP_PRIVATE_FILE
$source = $env:MURMUR_SETUP_ACCESS_SOURCE
$section = [System.Security.AccessControl.AccessControlSections]::Access
function AccessPolicy($acl) {
  $sddl = $acl.GetSecurityDescriptorSddlForm($section)
  # Windows marks a copied DACL as auto-inherited even when its ACEs are unchanged.
  # Ignore only that bookkeeping flag, retaining protection, order and every ACE.
  return [regex]::Replace($sddl, '^D:(?:P|AI|AR)*', { param($match) $match.Value.Replace('AI', '') })
}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# Match onboarding's new-profile policy: creator and the LocalSystem service.
# Existing replacements use their saved DACL below, including intentional readers.
$allowed = @($user, 'S-1-5-18') | Select-Object -Unique
$security = New-Object System.Security.AccessControl.FileSecurity
if ($source) {
  $original = Get-Acl -LiteralPath $source
  $expected = $original.GetSecurityDescriptorSddlForm($section)
  $security.SetSecurityDescriptorSddlForm($expected, $section)
  $expectedPolicy = AccessPolicy $original
} else {
  $security.SetAccessRuleProtection($true, $false)
  foreach ($id in $allowed) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($id)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    $security.AddAccessRule($rule)
  }
}
Set-Acl -LiteralPath $file -AclObject $security
$actual = Get-Acl -LiteralPath $file
if ($source) {
  if ((AccessPolicy $actual) -cne $expectedPolicy -or
      (AccessPolicy (Get-Acl -LiteralPath $source)) -cne $expectedPolicy) { throw 'changed access policy' }
  exit 0
}
if (!$actual.AreAccessRulesProtected) { throw 'unprotected ACL' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $allowed.Count) { throw 'unexpected ACL entries' }
foreach ($rule in $rules) {
  if ($allowed -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow' -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'unexpected ACL' }
}
`;

async function prepareFile(file: string, handle: FileHandle, accessSource?: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const opened = await handle.stat({ bigint: true });
  const before = await lstat(file, { bigint: true });
  if (!opened.isFile() || opened.size !== 0n || !before.isFile() || !sameClientFileIdentity(before, opened)) {
    throw new Error('private-file.target-invalid');
  }
  const sourceBefore = accessSource ? await lstat(accessSource, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }) : null;
  if (sourceBefore && (!sourceBefore.isFile() || sameClientFileIdentity(sourceBefore, opened))) {
    throw new Error('private-file.access-source-invalid');
  }
  try {
    await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protect, 'utf16le').toString('base64')],
      { env: { ...process.env, MURMUR_SETUP_PRIVATE_FILE: file, MURMUR_SETUP_ACCESS_SOURCE: sourceBefore ? accessSource : '' },
        windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    // Keep paths, command text and arbitrary PowerShell stderr out of diagnostics.
    const failure = error as { killed?: boolean; code?: string | number; stderr?: string };
    const rejection = ['changed access policy', 'unprotected ACL', 'unexpected ACL entries', 'unexpected ACL']
      .find(reason => failure.stderr?.includes(reason));
    const reason = failure.killed ? 'timeout' : failure.code === 'ENOENT' ? 'powershell-unavailable'
      : rejection?.replaceAll(' ', '-') ?? 'command-failed';
    throw new Error(`private-file.windows-acl-failed:${reason}`);
  }
  const after = await lstat(file, { bigint: true });
  if (!after.isFile() || !sameClientFileIdentity(after, opened)) throw new Error('private-file.target-changed');
  if (sourceBefore) {
    const sourceAfter = await lstat(accessSource!, { bigint: true });
    if (!sourceAfter.isFile() || !sameClientFileIdentity(sourceBefore, sourceAfter)) throw new Error('private-file.access-source-changed');
  }
}

/** Protect a newly created, still-empty setup output before writing credentials. */
export async function protectPrivateFile(file: string, handle: FileHandle): Promise<void> {
  return prepareFile(file, handle);
}

/** Existing Windows files keep their access policy, including intentional sandbox readers. */
export async function preparePrivateReplacement(file: string, handle: FileHandle, previous: string): Promise<void> {
  return prepareFile(file, handle, previous);
}
