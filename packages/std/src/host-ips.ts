/**
 * The IP addresses a URL's host name resolves to, from this server: for a
 * screen that shows a person which server an address points to (the Control
 * Center's Fleet list, docs/control-center.md). Read only. Nothing is stored
 * but a small in-memory cache.
 *
 * - A host that is already an IP gives `[]`: the address shows it.
 * - One lookup waits at most `timeoutMs` (1 s). A late answer still fills
 *   the cache, so the next read has it.
 * - A failed or empty lookup gives `[]`, never an error.
 * - IPv4 first, then IPv6, with no repeats.
 *
 * Behind split DNS or a proxy this is the IP THIS server resolves, which
 * can differ from the public one.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { TtlCache } from './ttl-cache';

export type HostLookup = (host: string) => Promise<{ address: string; family: number }[]>;

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 1_000;

const realLookup: HostLookup = (host) => dnsLookup(host, { all: true });

// Per host, the lookup itself: a late answer lands here for the next read.
const cache = new TtlCache<string, Promise<string[]>>({ ttlMs: TTL_MS, maxEntries: 1000 });

/** For tests. */
export function clearHostIpCache(): void {
  cache.clear();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function resolve(host: string, lookup: HostLookup): Promise<string[]> {
  return lookup(host).then(
    (rows) => {
      const v4 = rows.filter((r) => r.family === 4).map((r) => r.address);
      const v6 = rows.filter((r) => r.family !== 4).map((r) => r.address);
      return [...new Set([...v4, ...v6])];
    },
    () => [],
  );
}

/** The IPs of a URL's host, IPv4 first. `[]` for an IP host, a bad URL, a
 *  failed lookup, or one slower than the timeout. */
export async function hostIps(
  url: string,
  opts: { lookup?: HostLookup; timeoutMs?: number } = {},
): Promise<string[]> {
  const host = hostOf(url);
  if (!host || isIP(host)) return [];
  let ips = cache.get(host);
  if (!ips) {
    ips = resolve(host, opts.lookup ?? realLookup);
    cache.set(host, ips);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string[]>((done) => {
    timer = setTimeout(() => done([]), opts.timeoutMs ?? TIMEOUT_MS);
  });
  try {
    return await Promise.race([ips, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Each row with `ips`: the IPs of its `url`, all looked up at once. */
export async function withHostIps<T extends { url: string }>(
  rows: T[],
  opts: { lookup?: HostLookup; timeoutMs?: number } = {},
): Promise<(T & { ips: string[] })[]> {
  const ips = await Promise.all(rows.map((r) => hostIps(r.url, opts)));
  return rows.map((r, i) => ({ ...r, ips: ips[i] ?? [] }));
}
