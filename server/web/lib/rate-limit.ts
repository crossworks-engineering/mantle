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
/** The hard cap: past it the OLDEST buckets go, live or not. */
const HARD_MAX_BUCKETS = 2 * MAX_BUCKETS;
/** At most one full sweep a second (M2 audit F3): when the map is full of
 *  live buckets, a sweep on every new key scanned the whole map each time,
 *  so a flood of unique keys cost a full scan per request. */
const SWEEP_EVERY_MS = 1_000;
let lastSweepMs = 0;

/**
 * Drop expired buckets (at most once a second), and past the hard cap the
 * oldest buckets in insertion order. Losing a live bucket resets its
 * window early: the price of a bounded map under a flood of 20,000 unique
 * keys in one window, which the per-address limits in front of the
 * floodable callers (failed API keys, sign-in) make costly.
 */
function sweep(now: number, windowMs: number): void {
  if (now - lastSweepMs >= SWEEP_EVERY_MS) {
    lastSweepMs = now;
    for (const [k, b] of buckets) {
      if (now - b.windowStartMs >= windowMs) buckets.delete(k);
      if (buckets.size < MAX_BUCKETS / 2) break;
    }
  }
  if (buckets.size >= HARD_MAX_BUCKETS) {
    for (const k of buckets.keys()) {
      buckets.delete(k);
      if (buckets.size < MAX_BUCKETS) break;
    }
  }
}

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
    if (buckets.size >= MAX_BUCKETS) sweep(now, opts.windowMs);
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
  return clientIpFromHeaders(req.headers);
}

/** `clientIp` from bare headers (a Server Component's `headers()`). */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const xff = headers.get('x-forwarded-for');
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
  const xri = headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

/**
 * The eight groups of an IPv6 address, each without leading zeros, or null
 * when `ip` is not one. Accepts `::` shorthand, brackets, a zone id and an
 * embedded IPv4 tail (`::ffff:192.0.2.1`).
 */
function ipv6Groups(ip: string): string[] | null {
  let s = ip
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
    .toLowerCase();
  if (!s.includes(':')) return null;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}

/**
 * The rate-limit key for an address. An IPv6 address counts by its /64: one
 * host is handed a whole /64, so keying by the full address would give a
 * caller 2^64 fresh buckets (client logins audit B2, B11). An IPv4 address,
 * and an IPv4-mapped IPv6 one, counts as itself. Anything else (`unknown`)
 * is returned unchanged.
 */
export function ipRateKey(ip: string): string {
  const groups = ipv6Groups(ip);
  if (!groups) return ip.trim();
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const hi = parseInt(groups[6]!, 16);
    const lo = parseInt(groups[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** The caller's rate-limit key: `clientIp(req)` through `ipRateKey`. Use it
 *  for every per-address cap a stranger could dodge by rotating addresses. */
export function clientIpKey(req: Request): string {
  return ipRateKey(clientIp(req));
}
