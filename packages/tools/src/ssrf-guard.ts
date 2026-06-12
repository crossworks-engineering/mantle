/**
 * SSRF guard for agent-driven fetches (web_fetch and anything else that lets a
 * model choose a URL). Blocks loopback / private / link-local / CGNAT / cloud-
 * metadata / reserved addresses so an injected agent can't reach
 * `http://169.254.169.254/...`, an internal service, or a tailnet peer — and
 * re-checks the target after every redirect hop.
 *
 * Residual: there's a TOCTOU between our DNS check and fetch's own connect
 * (DNS rebinding). Pinning the resolved IP would need a custom connector and
 * breaks TLS SNI; on a single-owner self-hosted box the resolve-and-check guard
 * raises the bar enough to stop the realistic injection cases (literal metadata
 * IP, localhost, hostnames pointing at private space). Noted, not closed.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return (
    inCidr4(n, '0.0.0.0', 8) || // "this network"
    inCidr4(n, '10.0.0.0', 8) || // private
    inCidr4(n, '100.64.0.0', 10) || // CGNAT (Tailscale)
    inCidr4(n, '127.0.0.0', 8) || // loopback
    inCidr4(n, '169.254.0.0', 16) || // link-local + cloud metadata
    inCidr4(n, '172.16.0.0', 12) || // private
    inCidr4(n, '192.0.0.0', 24) || // IETF protocol assignments
    inCidr4(n, '192.168.0.0', 16) || // private
    inCidr4(n, '198.18.0.0', 15) || // benchmarking
    inCidr4(n, '224.0.0.0', 4) || // multicast
    inCidr4(n, '240.0.0.0', 4) // reserved
  );
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]!; // drop any zone id
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  const first = lower.startsWith('::') ? 0 : parseInt(lower.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return true;
  const firstByte = first >> 8;
  if (firstByte === 0xfc || firstByte === 0xfd) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** Is a literal IP in a blocked range? Unparseable → blocked (fail closed). */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true;
}

/** Throw if `rawUrl` is not an http(s) URL whose host resolves only to public
 *  addresses. Used before every fetch hop. */
export async function assertFetchableUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http(s) URLs are allowed');
  }
  let host = u.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`refusing to fetch a private/internal address (${host})`);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`cannot resolve host: ${host}`);
  }
  if (addrs.length === 0) throw new Error(`cannot resolve host: ${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`refusing to fetch ${host} — it resolves to a private/internal address`);
    }
  }
}

/**
 * fetch that runs the SSRF guard on the initial URL and on every redirect
 * target (following manually so a public URL can't 302 into private space).
 */
export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertFetchableUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error(`too many redirects (>${maxRedirects})`);
    current = new URL(location, current).toString();
  }
}
