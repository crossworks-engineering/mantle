import { env } from '@mantle/config';
/**
 * Tiny in-memory rate limiter — fixed window per key.
 *
 * Suitable for single-instance, single-user deployments (the Mantle
 * default). Process restart resets all counters; that's intentional —
 * we'd rather forget a hostile burst than persist it.
 *
 * If Mantle ever scales horizontally, swap this for a Redis-backed
 * `INCR + EXPIRE` or PG advisory locks; the API surface stays the same.
 */

type Bucket = {
  count: number;
  /** Wall-clock ms when the current window started. */
  windowStartMs: number;
};

const buckets = new Map<string, Bucket>();

/**
 * Test-stack escape hatch: multiply every window cap by a factor ≥ 1.
 * The e2e suite runs BOTH topology projects back-to-back from one IP, and
 * caps sized for humans (8 team-auth exchanges/min) sit exactly at the
 * suite's call count — any added spec 429s the later project. run-local.sh
 * sets MANTLE_RATE_LIMIT_SCALE=10 for the throwaway stack; unset (=1)
 * everywhere real. Parsed once at module load, deliberately — a runtime
 * toggle would make limiter behavior ambient state.
 */
const SCALE = (() => {
  const raw = Number(env('MANTLE_RATE_LIMIT_SCALE') ?? '1');
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
})();

/** Cap the map size so a flood of unique keys can't OOM the process. */
const MAX_BUCKETS = 10_000;

export type RateLimitResult = {
  ok: boolean;
  /** Seconds until the window resets. Useful for Retry-After. */
  retryAfterSec: number;
  remaining: number;
};

/**
 * Take one token from `key`'s bucket. Returns `{ok: false}` when the
 * window cap is exceeded.
 *
 *   const { ok, retryAfterSec } = rateLimit(`login:${ip}`, { max: 5, windowMs: 60_000 });
 *
 * Keys are namespaced by the caller — we don't enforce a format.
 */
export function rateLimit(key: string, opts: { max: number; windowMs: number }): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= opts.windowMs) {
    // Fresh window. Also opportunistically gc expired buckets if the
    // map is getting large, so the limiter stays bounded on a long-
    // running process.
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, b] of buckets) {
        if (now - b.windowStartMs >= opts.windowMs) buckets.delete(k);
        if (buckets.size < MAX_BUCKETS / 2) break;
      }
    }
    bucket = { count: 0, windowStartMs: now };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const max = opts.max * SCALE;
  const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStartMs + opts.windowMs - now) / 1000));
  if (bucket.count > max) {
    return { ok: false, retryAfterSec, remaining: 0 };
  }
  return { ok: true, retryAfterSec, remaining: max - bucket.count };
}

/**
 * Look at `key`'s bucket WITHOUT taking a token: `ok` is false when the
 * window already holds `max` hits, so the next take would be refused. For a
 * bucket that counts only some outcomes (failed invite codes, say): peek
 * before the work, take with rateLimit() after a failure.
 */
export function rateLimitPeek(
  key: string,
  opts: { max: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  const max = opts.max * SCALE;
  if (!bucket || now - bucket.windowStartMs >= opts.windowMs) {
    return { ok: true, retryAfterSec: 0, remaining: max };
  }
  const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStartMs + opts.windowMs - now) / 1000));
  return bucket.count >= max
    ? { ok: false, retryAfterSec, remaining: 0 }
    : { ok: true, retryAfterSec, remaining: max - bucket.count };
}

/**
 * Pull a stable client identifier from the request. Trusts the standard
 * reverse-proxy headers (`x-forwarded-for`, `x-real-ip`) which Caddy /
 * nginx set; falls back to `unknown` for direct connections.
 *
 * We don't include the user-agent — a sophisticated attacker can rotate
 * it cheaply and we don't want to give a free reset for trivial header
 * variation.
 *
 * X-Forwarded-For is `client, proxy1, proxy2, …`. The LEFTMOST entry is
 * client-supplied and therefore forgeable — keying on it lets an attacker mint a
 * fresh rate-limit bucket per request by rotating a fake `X-Forwarded-For`,
 * defeating the login/signup throttle. Caddy *appends* the address it observed,
 * so the entry our nearest trusted proxy added (counting `MANTLE_TRUSTED_PROXIES`
 * hops from the right, default 1) is the real, unspoofable client IP. Override
 * the hop count if you chain more than one trusted proxy.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      const hops = Math.max(1, Number(env('MANTLE_TRUSTED_PROXIES')) || 1);
      return parts[Math.max(0, parts.length - hops)]!;
    }
  }
  const xri = req.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

/**
 * The rate-limit key of an address: an IPv4 address as it is, an IPv6
 * address by its /64 (`2001:db8:1:2::/64`), because one subscriber holds a
 * whole /64 and could otherwise mint a fresh bucket per request. An
 * IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is its IPv4 address. A zone
 * (`%eth0`) and brackets are dropped. Anything that does not parse is
 * returned trimmed and lower-cased (`unknown` stays `unknown`).
 */
export function ipRateKey(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    s = end > 0 ? s.slice(1, end) : s.slice(1);
  }
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return s;
  const groups = expandIpv6(s);
  if (!groups) return s;
  const n = groups.map((g) => parseInt(g, 16));
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 address it carries.
  if (n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff) {
    return [n[6]! >> 8, n[6]! & 255, n[7]! >> 8, n[7]! & 255].join('.');
  }
  return `${n
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** The eight groups of an IPv6 address (an embedded IPv4 tail as two), or
 *  null when it does not parse. */
function expandIpv6(s: string): string[] | null {
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]!);
  const tail = halves.length === 2 ? split(halves[1]!) : [];
  const last = tail.length ? tail : head;
  const dotted = last[last.length - 1];
  if (dotted?.includes('.')) {
    const o = dotted.split('.').map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
    if (o.length !== 4 || o.some((x) => !(x >= 0 && x <= 255))) return null;
    last.splice(
      last.length - 1,
      1,
      ((o[0]! << 8) | o[1]!).toString(16),
      ((o[2]! << 8) | o[3]!).toString(16),
    );
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return all.length === 8 && all.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? all : null;
}

/** {@link clientIp} as a rate-limit key: an IPv6 caller by its /64. Use it
 *  for every per-address cap a stranger could dodge by rotating addresses. */
export function clientIpKey(req: Request): string {
  return ipRateKey(clientIp(req));
}
