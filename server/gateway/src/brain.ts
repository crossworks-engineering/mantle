/**
 * The gateway's two calls to its brain (docs/gateway.md), with its token:
 * the services it may route to (GET /api/gateway/registry) and its call
 * rows (POST /api/gateway/calls). The gateway holds no database login.
 *
 * The registry is kept `ttlMs` (a few seconds): a service switched off or
 * changed takes effect within it. When the brain does not answer, every
 * call is refused (RegistryUnavailable: 503), never served from an old copy.
 *
 * Call rows go in batches, in the background: a call never waits on its
 * row. A batch the brain does not take is lost (counted, said at most
 * every ten minutes); past `maxBuffer` rows waiting, a new row is dropped.
 */
import type { GatewayCallEntry } from '@mantle/db';
import { NET_TIMEOUTS, timeoutSignal, TtlCache } from '@mantle/std';
import type { RouteService } from './route';

/** The brain did not hand over the registry. */
export class RegistryUnavailable extends Error {
  override name = 'RegistryUnavailable';
}

export type BrainOptions = Readonly<{
  /** The brain's own origin on the stack's network (GATEWAY_BRAIN_URL). */
  url: string;
  token: string;
  fetch?: typeof fetch;
}>;

const TOKEN_HEADER = 'x-mantle-gateway-token';

function parseServices(body: unknown): Map<string, RouteService> | null {
  const list = (body as { services?: unknown } | null)?.services;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, RouteService>();
  for (const s of list) {
    if (typeof s !== 'object' || s === null) return null;
    const r = s as Record<string, unknown>;
    const strings = (v: unknown) =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
    const prefixes = strings(r.pathPrefixes);
    const methods = strings(r.methods);
    if (typeof r.slug !== 'string' || typeof r.upstream !== 'string' || !prefixes || !methods) {
      return null;
    }
    out.set(r.slug, {
      slug: r.slug,
      upstream: r.upstream,
      pathPrefixes: prefixes,
      methods,
      enabled: r.enabled === true,
    });
  }
  return out;
}

/** A lookup of one service by slug, over the brain's registry. */
export function brainRegistry(
  opts: BrainOptions & { ttlMs?: number; now?: () => number },
): (slug: string) => Promise<RouteService | null> {
  const f = opts.fetch ?? fetch;
  const cache = new TtlCache<'registry', Map<string, RouteService>>({
    ttlMs: opts.ttlMs ?? 5_000,
    ...(opts.now ? { now: opts.now } : {}),
  });
  let loading: Promise<Map<string, RouteService>> | null = null;

  async function load(): Promise<Map<string, RouteService>> {
    let res: Response;
    try {
      res = await f(`${opts.url}/api/gateway/registry`, {
        headers: { [TOKEN_HEADER]: opts.token },
        signal: timeoutSignal(NET_TIMEOUTS.gatewayRegistry),
      });
    } catch {
      throw new RegistryUnavailable('the brain did not answer');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new RegistryUnavailable(`the brain answered ${res.status}`);
    }
    const map = parseServices(await res.json().catch(() => null));
    if (!map) throw new RegistryUnavailable('the brain sent no registry');
    cache.set('registry', map);
    return map;
  }

  return async (slug) => {
    // A stale copy is never served: past its time the lookup waits for the
    // brain, and fails when the brain does not answer.
    const map =
      cache.get('registry') ??
      (await (loading ??= load().finally(() => {
        loading = null;
      })));
    return map.get(slug) ?? null;
  };
}

/** The call rows' road to the brain. */
export function callShipper(
  opts: BrainOptions & { flushMs?: number; maxBatch?: number; maxBuffer?: number },
): { add: (e: GatewayCallEntry) => void; flush: () => Promise<void> } {
  const f = opts.fetch ?? fetch;
  const flushMs = opts.flushMs ?? 2_000;
  const maxBatch = opts.maxBatch ?? 500;
  const maxBuffer = opts.maxBuffer ?? 5_000;
  const buffer: GatewayCallEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> | null = null;
  let lost = 0;
  let lastWarn = 0;

  const loseRows = (n: number) => {
    lost += n;
    const now = Date.now();
    if (now - lastWarn < 10 * 60_000) return;
    lastWarn = now;
    console.warn(`[gateway] ${lost} call row(s) not logged: the brain did not take them`);
    lost = 0;
  };

  async function send(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = buffer.splice(0, maxBatch);
    if (batch.length === 0) return;
    try {
      const res = await f(`${opts.url}/api/gateway/calls`, {
        method: 'POST',
        headers: { [TOKEN_HEADER]: opts.token, 'content-type': 'application/json' },
        body: JSON.stringify({ calls: batch }),
        signal: timeoutSignal(NET_TIMEOUTS.gatewayCalls),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) loseRows(batch.length);
    } catch {
      loseRows(batch.length);
    }
  }

  function schedule(): void {
    if (sending) return;
    if (buffer.length >= maxBatch) {
      sending = send().finally(() => {
        sending = null;
        if (buffer.length > 0) schedule();
      });
      return;
    }
    if (!timer && buffer.length > 0) {
      timer = setTimeout(() => {
        timer = null;
        sending = send().finally(() => {
          sending = null;
          if (buffer.length > 0) schedule();
        });
      }, flushMs);
      timer.unref?.();
    }
  }

  return {
    add(e) {
      if (buffer.length >= maxBuffer) return loseRows(1);
      buffer.push(e);
      schedule();
    },
    async flush() {
      if (sending) await sending;
      while (buffer.length > 0) await send();
    },
  };
}
