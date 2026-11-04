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
 * on, less each one a stack name resolves into (the database host,
 * postgres, the object store, web, api, caddy: all on the default
 * network). With one interface, or when no subnet is left, every upstream
 * is refused (fail closed). The gateway also listens only on its own
 * address on the default network, and drops a connection from a services
 * subnet: a service never calls the gateway.
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

/** One IPv4 interface of this host: its address and its subnet. */
export type Iface = Readonly<{ address: string; cidr: Cidr }>;

/** This host's own IPv4 interfaces, loopback left out. */
export function interfaces(
  ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): Iface[] {
  const out: Iface[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue;
      const c = parseCidr(a.cidr);
      if (c) out.push({ address: a.address, cidr: c });
    }
  }
  return out;
}

/**
 * The stack's own names on the default network. Each one the gateway can
 * resolve marks the subnets its answers fall in as default subnets. A box
 * service that took one of these names as an alias on mantle_services would
 * mark the services subnet default too: no services subnet is left, and the
 * gateway refuses every upstream (fail closed), never the other way round.
 */
export const DEFAULT_NETWORK_NAMES = ['postgres', 'objectstore', 'web', 'api', 'caddy'] as const;

/** Where the gateway may connect and listen (see the head). */
export type NetworkPlan = Readonly<{
  /** The services subnets; empty: every upstream is refused. */
  cidrs: Cidr[];
  /** The gateway's own address on the default network, to listen on
   *  (null: not found; the caller listens on GATEWAY_HOST or everywhere and
   *  drops connections from a services subnet). */
  listen: string | null;
  /** This host's own addresses: never an upstream. */
  own: string[];
  how: string;
}>;

/**
 * The plan. `configured` is GATEWAY_UPSTREAM_CIDRS; `probeHosts` the names
 * to resolve for the default network (the database host first).
 */
export async function networkPlan(
  configured: string | undefined,
  probeHosts: readonly string[],
  ifs: Iface[] = interfaces(),
  resolve: (h: string) => Promise<string[]> = resolveV4,
): Promise<NetworkPlan> {
  const own = ifs.map((i) => i.address);
  if (configured && configured.trim()) {
    const cidrs = configured
      .split(',')
      .map((s) => parseCidr(s))
      .filter((c): c is Cidr => c !== null);
    return { cidrs, listen: null, own, how: 'GATEWAY_UPSTREAM_CIDRS' };
  }
  const none = (how: string): NetworkPlan => ({ cidrs: [], listen: null, own, how });
  if (ifs.length < 2) return none('one interface: no services network found');
  const answers: string[] = [];
  for (const h of new Set(probeHosts)) {
    if (net.isIPv4(h)) answers.push(h);
    else answers.push(...(await resolve(h).catch(() => [] as string[])));
  }
  if (answers.length === 0) return none('no stack name resolved: no default network found');
  const defaults = ifs.filter((i) => answers.some((a) => inCidr(a, i.cidr)));
  if (defaults.length === 0) {
    return none("the stack's names resolve onto none of this host's subnets");
  }
  const services = ifs.filter((i) => !defaults.includes(i));
  if (services.length === 0) {
    return none('every subnet of this host holds a stack name: no services network is left');
  }
  return {
    cidrs: services.map((i) => i.cidr),
    listen: defaults.length === 1 ? defaults[0]!.address : null,
    own,
    how: `interfaces, less the default network's ${defaults.map((i) => i.cidr.text).join(', ')}`,
  };
}

async function resolveV4(host: string): Promise<string[]> {
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
