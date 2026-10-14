/**
 * One egress fetch (A10 part 1, docs/egress.md): every fetch of a URL that a
 * user, a model, a remote server or a linked peer gave goes through
 * `egressFetch`. Node only (`@mantle/std/egress`), so the browser bundles
 * that import `@mantle/std` stay free of node builtins.
 *
 * What it does on top of the platform fetch:
 *  - the address check on EVERY hop: redirects are followed by hand, and each
 *    target is resolved and refused when it lands on a private, loopback,
 *    link-local, CGNAT, cloud metadata or reserved address;
 *  - secret headers are dropped on a hop to another origin: Authorization,
 *    Cookie and Proxy-Authorization by name (as the platform does), and any
 *    header whose value carries one of the caller's `secrets` (the platform
 *    keeps custom headers such as `x-api-key` across origins);
 *  - an optional timeout over the whole exchange, body included;
 *  - an optional byte cap, applied while the body streams: reading stops at
 *    `maxBytes` (an error, or the first `maxBytes` with `overflow:
 *    'truncate'`), so an oversized body is never held whole.
 *
 * `allowLan` is the caller's config, not the URL's: a linked peer brain or a
 * local model on a private or tailnet address is legitimate. It lets the
 * private ranges (RFC 1918, loopback, CGNAT, unique local IPv6) through and
 * still refuses link-local (the cloud metadata address lives there),
 * "this network", multicast and reserved space.
 *
 * Residual (unchanged from the guard this replaces): a TOCTOU between the
 * DNS check and the platform's own connect (DNS rebinding). Pinning the
 * resolved IP needs a custom connector and breaks TLS SNI; resolve and check
 * stops the realistic injection cases (a literal metadata IP, localhost, a
 * name pointing into private space). Noted, not closed.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';

export type EgressOptions = {
  /** Abort the whole exchange (every hop and the body read) after this many
   *  ms. Absent: no deadline beyond the caller's own `init.signal`. */
  timeoutMs?: number;
  /** The most response body bytes to read. Absent: no cap. */
  maxBytes?: number;
  /** At the cap: fail the read (`error`, the default) or end the body there
   *  (`truncate`). */
  overflow?: 'error' | 'truncate';
  /** Values a header must not carry to another origin (a resolved API key,
   *  a token). */
  secrets?: readonly string[];
  /** The caller's config allows private and tailnet addresses (a linked
   *  peer, a local model). Link-local and metadata stay refused. */
  allowLan?: boolean;
  /** Redirect hops to follow (default 5). */
  maxRedirects?: number;
  /** `follow` (the default): follow by hand, checking every hop. `error`:
   *  refuse any redirect outright, as the platform's `redirect: 'error'`. */
  redirect?: 'follow' | 'error';
  /** A deliberate carve the caller owns (the sandbox service proxy in
   *  @mantle/tools): a URL it accepts skips the address check. */
  exempt?: (u: URL) => boolean;
  /** Replaces the address check (the caller's own guard; tests drive
   *  loopback servers with a permissive one). */
  guard?: (url: string) => Promise<void>;
};

/** The address check refused a URL. */
export class EgressRefusedError extends Error {
  override name = 'EgressRefusedError';
}

/** The body went over `maxBytes`. */
export class EgressTooLargeError extends Error {
  override name = 'EgressTooLargeError';
}

const DEFAULT_MAX_REDIRECTS = 5;

/** Dropped by name on a hop to another origin, matching the platform. */
const CROSS_ORIGIN_STRIP = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Statuses whose response carries no body (a Response cannot be built with
 *  one). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

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

/** Never reachable, whatever the caller's config. */
function isAlwaysBlockedIpv4(n: number): boolean {
  return (
    inCidr4(n, '0.0.0.0', 8) || // "this network"
    inCidr4(n, '169.254.0.0', 16) || // link-local + cloud metadata
    inCidr4(n, '224.0.0.0', 4) || // multicast
    inCidr4(n, '240.0.0.0', 4) // reserved
  );
}

/** Private space a LAN caller may reach. */
function isLanIpv4(n: number): boolean {
  return (
    inCidr4(n, '10.0.0.0', 8) || // private
    inCidr4(n, '100.64.0.0', 10) || // CGNAT (Tailscale)
    inCidr4(n, '127.0.0.0', 8) || // loopback
    inCidr4(n, '172.16.0.0', 12) || // private
    inCidr4(n, '192.0.0.0', 24) || // IETF protocol assignments
    inCidr4(n, '192.168.0.0', 16) || // private
    inCidr4(n, '198.18.0.0', 15) // benchmarking
  );
}

function isBlockedIpv4(ip: string, allowLan: boolean): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  if (isAlwaysBlockedIpv4(n)) return true;
  return !allowLan && isLanIpv4(n);
}

/** An IPv6 literal as 16 bytes, or null. Takes any textual form (`::`
 *  compression, an embedded dotted quad, a zone id), since a DNS answer and
 *  the URL parser's canonical form differ: the parser turns
 *  `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`. */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let s = ip.split('%')[0]!.toLowerCase();
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2]!);
    if (v4 === null) return null;
    tail.push((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
    s = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const groupsLeft = 8 - tail.length / 2;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = groupsLeft - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    if (head.length !== groupsLeft) return null;
    groups = head;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  bytes.set(tail, 16 - tail.length);
  return bytes;
}

function v4At(b: Uint8Array, at: number): string {
  return `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;
}

function zeroes(b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
}

function isBlockedIpv6(ip: string, allowLan: boolean): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true;
  if (zeroes(b, 0, 16)) return true; // :: unspecified
  if (zeroes(b, 0, 15) && b[15] === 1) return !allowLan; // ::1 loopback
  // Forms that carry an IPv4 address: the v4 rules decide. ::ffff:0:0/96
  // (IPv4-mapped), ::/96 (IPv4-compatible, deprecated), ::ffff:0:0:0/96
  // (IPv4-translated), 64:ff9b::/96 (NAT64 well-known prefix) and
  // 2002::/16 (6to4, the v4 in bytes 2..5).
  if (zeroes(b, 0, 10) && b[10] === 0xff && b[11] === 0xff)
    return isBlockedIpv4(v4At(b, 12), allowLan);
  if (zeroes(b, 0, 12)) return isBlockedIpv4(v4At(b, 12), allowLan);
  if (zeroes(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return isBlockedIpv4(v4At(b, 12), allowLan);
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeroes(b, 4, 12)) {
    return isBlockedIpv4(v4At(b, 12), allowLan);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4(v4At(b, 2), allowLan);
  // Refused whatever the caller's config.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // 64:ff9b:1::/48 local NAT64 (and the rest of 64:ff9b::/32)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32 Teredo (tunnels to a v4 peer)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zeroes(b, 2, 8)) return true; // 100::/64 discard-only
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if ((b[0]! & 0xfe) === 0xfc) return !allowLan; // fc00::/7 unique-local
  return false;
}

/** Is a literal IP one this caller may not reach? Unparseable: blocked
 *  (fail closed). */
export function isBlockedIp(ip: string, opts: { allowLan?: boolean } = {}): boolean {
  const allowLan = opts.allowLan === true;
  if (net.isIPv4(ip)) return isBlockedIpv4(ip, allowLan);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip, allowLan);
  return true;
}

/**
 * Throw (EgressRefusedError) unless `rawUrl` is an http(s) URL whose host
 * resolves only to addresses this caller may reach. Runs before every hop.
 * A name that does not resolve is refused, except for a LAN caller: there
 * the platform's own connect reports it, as it did before the fold.
 */
export async function assertEgressUrl(
  rawUrl: string,
  opts: Pick<EgressOptions, 'allowLan' | 'exempt'> = {},
): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new EgressRefusedError('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new EgressRefusedError('only http(s) URLs are allowed');
  }
  if (opts.exempt?.(u)) return;
  let host = u.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (net.isIP(host)) {
    if (isBlockedIp(host, opts)) {
      throw new EgressRefusedError(`refusing to fetch a private/internal address (${host})`);
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    if (opts.allowLan) return;
    throw new EgressRefusedError(`cannot resolve host: ${host}`);
  }
  if (addrs.length === 0) {
    if (opts.allowLan) return;
    throw new EgressRefusedError(`cannot resolve host: ${host}`);
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address, opts)) {
      throw new EgressRefusedError(
        `refusing to fetch ${host} \u2014 it resolves to a private/internal address`,
      );
    }
  }
}

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init ?? {}).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

/** `res` with its body read under a cap: past `maxBytes` the stream errors
 *  (or ends, for `truncate`) and the upstream read is cancelled. */
function capBody(
  res: Response,
  maxBytes: number,
  overflow: 'error' | 'truncate',
  finalUrl: string,
): Response {
  if (!res.body || NULL_BODY.has(res.status)) return res;
  const reader = res.body.getReader();
  let seen = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { done, value } = await reader.read();
      if (done) {
        ctrl.close();
        return;
      }
      const room = maxBytes - seen;
      if (value.byteLength <= room) {
        seen += value.byteLength;
        ctrl.enqueue(value);
        return;
      }
      await reader.cancel().catch(() => {});
      if (overflow === 'truncate') {
        if (room > 0) ctrl.enqueue(value.subarray(0, room));
        seen = maxBytes;
        ctrl.close();
        return;
      }
      ctrl.error(new EgressTooLargeError(`response body is over the ${maxBytes}-byte cap`));
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const out = new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  Object.defineProperty(out, 'url', { value: finalUrl });
  return out;
}

/**
 * fetch a URL that came from outside, with the address check on every hop,
 * secret headers dropped across origins, an optional deadline and an
 * optional streamed byte cap. Method and body downgrade on a redirect as
 * the platform does: 303 always goes to GET, a 301 or 302 on POST goes to
 * GET; 307 and 308 keep both.
 */
export async function egressFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: EgressOptions = {},
): Promise<Response> {
  const guard =
    opts.guard ??
    ((u: string) => assertEgressUrl(u, { allowLan: opts.allowLan, exempt: opts.exempt }));

  let signal = init.signal ?? undefined;
  if (opts.timeoutMs !== undefined) {
    // The deadline covers the body read too, so it stays armed after the
    // headers arrive; unref'd, it never holds the process open, and firing
    // after a finished read aborts nothing. A plain abort, so the error reads
    // as the callers' own timers read before the fold ("This operation was
    // aborted").
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    signal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  }

  if (opts.redirect === 'error') {
    // One hop, the platform refuses a redirect: the input passes through
    // as given (a Request keeps its own method, headers and body).
    await guard(urlOf(input));
    const res = await fetch(input, { ...init, redirect: 'error', signal });
    return opts.maxBytes === undefined
      ? res
      : capBody(res, opts.maxBytes, opts.overflow ?? 'error', res.url || urlOf(input));
  }

  const carriers = (opts.secrets ?? []).filter((s) => s.length > 0);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const req = input instanceof Request ? input : null;
  let currentUrl = urlOf(input);
  let method = (init.method ?? req?.method ?? 'GET').toUpperCase();
  let headers = headerRecord(init.headers ?? req?.headers);
  let body = init.body ?? (req ? req.body : undefined);

  for (let hop = 0; ; hop++) {
    await guard(currentUrl);
    const res = await fetch(currentUrl, {
      ...init,
      method,
      headers,
      body,
      signal,
      redirect: 'manual',
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) {
      return opts.maxBytes === undefined
        ? res
        : capBody(res, opts.maxBytes, opts.overflow ?? 'error', currentUrl);
    }
    if (hop >= maxRedirects) throw new Error(`too many redirects (>${maxRedirects})`);
    await res.body?.cancel().catch(() => {});

    const next = new URL(location, currentUrl);
    if (next.origin !== new URL(currentUrl).origin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(
          ([k, v]) =>
            !CROSS_ORIGIN_STRIP.has(k.toLowerCase()) && !carriers.some((s) => v.includes(s)),
        ),
      );
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-/i.test(k)));
    }
    currentUrl = next.toString();
  }
}
