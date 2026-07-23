import { promises as dns } from 'dns';
import net from 'net';
import { BadRequestError } from './AppError';

/**
 * True when an IPv4/IPv6 address is loopback, private, link-local, CGNAT, or
 * otherwise not publicly routable — i.e. an SSRF target we must never let a
 * user-supplied URL reach (includes the cloud-metadata IP 169.254.169.254).
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const addr = ip.toLowerCase();
    if (addr === '::1' || addr === '::') return true;
    if (addr.startsWith('fe80')) return true; // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

/** Blocked hostnames that should never be reached regardless of DNS. */
function isBlockedHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  );
}

/**
 * Synchronous, DNS-free sanity check for user input (validators): the URL must
 * be https, not a blocked host, and not a private IP literal. Cannot catch a
 * hostname that resolves to a private IP — use assertSafePublicUrl at call time
 * for that.
 */
export function isSafePublicUrlSync(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (isBlockedHost(host)) return false;
    if (net.isIP(host) && isPrivateIp(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Call-time guard against SSRF: the URL must be https and its hostname must not
 * resolve to a private/loopback/link-local address. Resolving here (not just at
 * input time) also defeats DNS-rebinding to the metadata endpoint. Throws
 * BadRequestError on any violation.
 */
export async function assertSafePublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestError('Invalid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestError('URL must use https.');
  }
  const host = url.hostname.toLowerCase();
  if (isBlockedHost(host)) {
    throw new BadRequestError('URL host is not allowed.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new BadRequestError('URL host is not allowed.');
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new BadRequestError('URL host could not be resolved.');
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw new BadRequestError('URL host is not allowed.');
  }
}
