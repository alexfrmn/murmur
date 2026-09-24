import { BlockList, isIP } from 'node:net';

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) nonPublic.addSubnet(network, prefix, 'ipv6');
const privateSuffixes = ['local', 'localhost', 'localdomain', 'ts.net', 'internal', 'home.arpa', 'lan'];

/** Address policy only: Invitation creation never connects or claims reachability. */
export function invitationServerAddress(value: string): string {
  let host: string;
  try {
    // URL parsing otherwise silently removes whitespace and controls. Never let the
    // checked address and the value carried in the Invitation disagree that way.
    if (/[\s\x00-\x1f\x7f\\]/u.test(value)) throw new Error();
    const url = new URL(value);
    if (!['nats:', 'tls:'].includes(url.protocol) || !url.host || url.username || url.password
      || url.search || url.hash || !['', '/'].includes(url.pathname) || url.port === '0') throw new Error();
    // nats/tls are opaque-host URL schemes. The standard HTTP host parser also
    // recognizes numeric, short, hex and octal IPv4 spellings (127.1, 0x7f000001),
    // percent-encoded hostnames, case and IPv4-mapped IPv6, without a DNS lookup.
    host = new URL(`http://${url.host}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!isIP(host) && (host.length > 253 || !host.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new Error();
  } catch {
    throw new Error('onboarding.invite-server-address-invalid');
  }
  const family = isIP(host);
  // BlockList checks IPv4 rules for mapped IPv6 too; ::ffff:192.168.1.1 cannot
  // turn a private IPv4 destination into a public Invitation address.
  const privateAddress = family ? nonPublic.check(host, family === 4 ? 'ipv4' : 'ipv6')
    : !host.includes('.') || privateSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  if (privateAddress) throw new Error('onboarding.invite-public-server-required');
  return value;
}
