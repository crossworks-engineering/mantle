/**
 * Where the gateway may connect: an address on the mantle_services network
 * only. A registered upstream is a DNS name (the database refuses an IP and
 * the stack's own names), and the gateway sits on the default network too,
 * so the name is resolved here and the connection goes to a checked
 * address: one inside a services subnet, never one of the default network
 * (postgres, the object store, the app services) or anything else.
 *
 * The services subnets: GATEWAY_UPSTREAM_CIDRS when set (a test, or a box
 * that runs the gateway outside compose), else found at start from the
 * container's own interfaces: every IPv4 subnet the gateway has an address
 * on, less the one that holds the database host (DATABASE_URL's host is on
 * the default network). With one interface, or when the database host is
 * on none of them, no subnet is the services one and every upstream is
 * refused (fail closed).
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';

export type Cidr = Readonly<{ base: number; bits: number; text: string }>;

function ipv4ToInt(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}

function maskOf(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** `a.b.c.d/n`, or null. */
export function parseCidr(text: string): Cidr | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const ip = ipv4ToInt(m[1]!);
  const bits = Number(m[2]);
  if (ip === null || bits < 8 || bits > 32) return null;
  const base = (ip & maskOf(bits)) >>> 0;
  const dotted = [24, 16, 8, 0].map((sh) => (base >>> sh) & 0xff).join('.');
  return { base, bits, text: `${dotted}/${bits}` };
}

export function inCidr(ip: string, c: Cidr): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && (n & maskOf(c.bits)) >>> 0 === c.base;
}

/** The IPv4 subnets of this host's own interfaces, loopback left out. */
export function interfaceCidrs(
  ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): Cidr[] {
  const out: Cidr[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue;
      const c = parseCidr(a.cidr);
      if (c && !out.some((o) => o.base === c.base && o.bits === c.bits)) out.push(c);
    }
  }
  return out;
}

/**
 * The services subnets (see the head). `configured` is
 * GATEWAY_UPSTREAM_CIDRS; `defaultHost` the database host.
 */
export async function servicesCidrs(
  configured: string | undefined,
  defaultHost: string | null,
  ifaces: Cidr[] = interfaceCidrs(),
  resolve: (h: string) => Promise<string[]> = resolveV4,
): Promise<{ cidrs: Cidr[]; how: string }> {
  if (configured && configured.trim()) {
    const cidrs = configured
      .split(',')
      .map((s) => parseCidr(s))
      .filter((c): c is Cidr => c !== null);
    return { cidrs, how: 'GATEWAY_UPSTREAM_CIDRS' };
  }
  if (!defaultHost || ifaces.length < 2) {
    return { cidrs: [], how: 'one interface or no database host: no services network found' };
  }
  let dbAddrs: string[] = [];
  try {
    dbAddrs = net.isIPv4(defaultHost) ? [defaultHost] : await resolve(defaultHost);
  } catch {
    return { cidrs: [], how: `the database host ${defaultHost} did not resolve` };
  }
  const defaults = ifaces.filter((c) => dbAddrs.some((a) => inCidr(a, c)));
  if (defaults.length === 0) {
    return { cidrs: [], how: `the database host ${defaultHost} is on none of this host's subnets` };
  }
  const cidrs = ifaces.filter((c) => !defaults.includes(c));
  return {
    cidrs,
    how: `interfaces, less the database's ${defaults.map((c) => c.text).join(', ')}`,
  };
}

async function resolveV4(host: string): Promise<string[]> {
  const addrs = await lookup(host, { all: true, family: 4 });
  return addrs.map((a) => a.address);
}

/** The address to connect to for `host`: its first answer when every answer
 *  lies in a services subnet, else null. */
export async function checkedAddress(
  host: string,
  cidrs: readonly Cidr[],
  resolve: (h: string) => Promise<string[]> = resolveV4,
): Promise<string | null> {
  if (cidrs.length === 0 || net.isIP(host)) return null;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    return null;
  }
  if (addrs.length === 0) return null;
  if (!addrs.every((a) => cidrs.some((c) => inCidr(a, c)))) return null;
  return addrs[0]!;
}
