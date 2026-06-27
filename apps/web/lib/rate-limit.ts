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
export function rateLimit(
  key: string,
  opts: { max: number; windowMs: number },
): RateLimitResult {
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
  const retryAfterSec = Math.max(
    1,
    Math.ceil((bucket.windowStartMs + opts.windowMs - now) / 1000),
  );
  if (bucket.count > opts.max) {
    return { ok: false, retryAfterSec, remaining: 0 };
  }
  return { ok: true, retryAfterSec, remaining: opts.max - bucket.count };
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
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      const hops = Math.max(1, Number(process.env.MANTLE_TRUSTED_PROXIES) || 1);
      return parts[Math.max(0, parts.length - hops)]!;
    }
  }
  const xri = req.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}
