/**
 * Where the gateway may connect and listen. Its services subnet is fixed:
 * GATEWAY_UPSTREAM_CIDRS, which compose sets to mantle_services' own
 * range (MANTLE_SERVICES_SUBNET, the network's ipam subnet). Unset or
 * unreadable: no subnet, and every upstream is refused (fail closed).
 *
 * A registered upstream is a single DNS label (the registry's rule), so it
 * is resolved here and the connection goes to a checked address: one inside
 * the services subnet that is not the subnet's own, its first host (the
 * bridge, the Docker host), its broadcast or the gateway itself.
 *
 * The gateway listens on its one address outside the services subnet (the
 * default network, where the brain is) and drops a connection that comes
 * from inside it: a service never calls the gateway.
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

/** The services subnets from GATEWAY_UPSTREAM_CIDRS (comma separated). */
export function servicesCidrs(configured: string | undefined): Cidr[] {
  return (configured ?? '')
    .split(',')
    .map((s) => parseCidr(s))
    .filter((c): c is Cidr => c !== null);
}

export function inCidr(ip: string, c: Cidr): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && (n & maskOf(c.bits)) >>> 0 === c.base;
}

/** This host's own IPv4 addresses, loopback left out. */
export function ownAddresses(
  ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/** The address to listen on: this host's one address outside every
 *  services subnet, or null (none, or more than one). */
export function listenAddress(own: readonly string[], cidrs: readonly Cidr[]): string | null {
  const outside = own.filter((a) => !cidrs.some((c) => inCidr(a, c)));
  return outside.length === 1 ? outside[0]! : null;
}

export async function resolveV4(host: string): Promise<string[]> {
  const addrs = await lookup(host, { all: true, family: 4 });
  return addrs.map((a) => a.address);
}

/** Whether `ip` is one a service may have in `c`: not the subnet's own
 *  address, its first host (the bridge's gateway, the Docker host) or its
 *  broadcast. */
function serviceAddressIn(ip: string, c: Cidr): boolean {
  const n = ipv4ToInt(ip);
  if (n === null || !inCidr(ip, c)) return false;
  const last = (c.base | (~maskOf(c.bits) >>> 0)) >>> 0;
  return n !== c.base && n !== c.base + 1 && n !== last;
}

/** The address to connect to for `host`: its first answer when every answer
 *  is a service's address in a services subnet and none is this host's
 *  own, else null. */
export async function checkedAddress(
  host: string,
  cidrs: readonly Cidr[],
  own: readonly string[] = [],
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
  const ok = (a: string) => !own.includes(a) && cidrs.some((c) => serviceAddressIn(a, c));
  if (!addrs.every(ok)) return null;
  return addrs[0]!;
}

/** Whether a connection's remote address lies in a services subnet (the
 *  gateway drops it: services never call the gateway). */
export function fromServices(remote: string | undefined, cidrs: readonly Cidr[]): boolean {
  if (!remote) return false;
  const ip = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  return cidrs.some((c) => inCidr(ip, c));
}
