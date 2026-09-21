import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { NatsTlsOptions } from '@murmurv2/core';

export interface BrokerInputFiles {
  tokenFile?: string;
  userFile?: string;
  passwordFile?: string;
  caFile?: string;
  serverName?: string;
}
export interface BrokerAuthConfig { natsToken?: string; natsUser?: string; natsPassword?: string; natsTls?: NatsTlsOptions }
export interface BrokerInputSnapshot { config: BrokerAuthConfig; proof: string }

async function checkedFile(file: string, secret: boolean, limit: number): Promise<{ text: string; file: string; proof: string }> {
  if (!path.isAbsolute(file)) throw new Error('broker-input.file-must-be-absolute');
  const pathInfo = await lstat(file);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error('broker-input.file-invalid');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error('broker-input.file-invalid');
    if (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) throw new Error('broker-input.file-changed');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('broker-input.owner-mismatch');
    if (secret && process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('broker-input.file-not-private');
    const bytes=Buffer.alloc(limit+1);let offset=0;
    while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,null);if(result.bytesRead===0)break;offset+=result.bytesRead;}
    const after=await handle.stat();
    if(offset>limit || after.dev!==info.dev || after.ino!==info.ino || after.size!==info.size || offset!==info.size) throw new Error('broker-input.file-changed');
    const content=bytes.subarray(0,offset), text=content.toString('utf8');
    if (text.includes('\0')) throw new Error(secret ? 'broker-input.secret-invalid' : 'broker-input.file-invalid');
    return { text, file, proof:createHash('sha256').update(content).digest('hex') };
  } finally { await handle.close(); }
}

export async function readBrokerInputsSnapshot(input: BrokerInputFiles): Promise<BrokerInputSnapshot> {
  if (input.tokenFile && (input.userFile || input.passwordFile)) throw new Error('nats-auth-methods-conflict');
  if (!!input.userFile !== !!input.passwordFile) throw new Error('nats-user-password-pair-required');
  const out: BrokerAuthConfig = {};
  const proofs: string[]=[];
  if (input.tokenFile) {
    const { text,proof } = await checkedFile(input.tokenFile, true, 16 * 1024);proofs.push(`token:${proof}`);
    const value=text.replace(/\r?\n$/,'');
    if (!value || /[\r\n]/.test(value)) throw new Error('broker-input.secret-invalid');
    out.natsToken = value;
  }
  if (input.userFile && input.passwordFile) {
    const [{ text: user,proof:userProof }, { text: password,proof:passwordProof }] = await Promise.all([
      checkedFile(input.userFile, true, 16 * 1024), checkedFile(input.passwordFile, true, 16 * 1024),
    ]);
    proofs.push(`user:${userProof}`,`password:${passwordProof}`);
    const userValue=user.replace(/\r?\n$/,''), passwordValue=password.replace(/\r?\n$/,'');
    if (!userValue || !passwordValue || /[\r\n]/.test(userValue) || /[\r\n]/.test(passwordValue)) throw new Error('broker-input.secret-invalid');
    out.natsUser = userValue; out.natsPassword = passwordValue;
  }
  if (input.caFile || input.serverName) {
    if (input.caFile) proofs.push(`ca:${(await checkedFile(input.caFile, false, 1024 * 1024)).proof}`);
    out.natsTls = { ...(input.caFile ? { caFile: input.caFile } : {}), ...(input.serverName ? { serverName: input.serverName } : {}) };
  }
  proofs.push(`server:${input.serverName??''}`);
  return {config:out,proof:createHash('sha256').update(proofs.join('\0')).digest('hex')};
}

export async function readBrokerInputs(input: BrokerInputFiles): Promise<BrokerAuthConfig> { return (await readBrokerInputsSnapshot(input)).config; }

/** Recheck persisted TLS paths immediately before a network client consumes them. */
export async function validateConfiguredTlsFiles(config: { natsTls?: NatsTlsOptions }): Promise<void> {
  const tls=config.natsTls;if(!tls)return;
  if(tls.caFile)await checkedFile(tls.caFile,false,1024*1024);
  if(tls.certFile)await checkedFile(tls.certFile,false,1024*1024);
  if(tls.keyFile)await checkedFile(tls.keyFile,true,1024*1024);
}
