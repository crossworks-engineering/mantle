/**
 * The gateway's calls to its brain: the registry (kept a few seconds, fail
 * closed) and the call batches (in the background, a lost batch dropped).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayCallEntry } from '@mantle/db';
import { brainFetch, brainRegistry, callShipper, RegistryUnavailable } from './brain';
import { parseCidr } from './upstream';

const svc = {
  slug: 'billing',
  upstream: 'billing-agent:8080',
  pathPrefixes: ['/mcp'],
  methods: ['POST'],
  enabled: true,
};
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('brainRegistry', () => {
  it('reads the registry with the token, and keeps it for its time', async () => {
    const seen: Array<[string, string | null]> = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push([String(url), new Headers(init?.headers).get('x-mantle-gateway-token')]);
      return ok({ services: [svc] });
    }) as unknown as typeof fetch;
    const lookup = brainRegistry({ url: 'http://web:3000', token: 'tok', fetch: f, ttlMs: 60_000 });
    expect(await lookup('billing')).toEqual(svc);
    expect(await lookup('nope')).toBeNull();
    expect(seen).toEqual([['http://web:3000/api/gateway/registry', 'tok']]);
  });

  it('fails closed when the brain does not answer, answers wrongly, or the copy is stale', async () => {
    let up = true;
    const f = (async () => {
      if (!up) throw new TypeError('fetch failed');
      return ok({ services: [svc] });
    }) as unknown as typeof fetch;
    const lookup = brainRegistry({ url: 'http://web:3000', token: 't', fetch: f, ttlMs: 0 });
    expect(await lookup('billing')).toEqual(svc);
    up = false;
    await expect(lookup('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    for (const res of [
      new Response('no', { status: 401 }),
      ok({ nope: 1 }),
      ok({ services: [{}] }),
    ]) {
      const bad = brainRegistry({
        url: 'u',
        token: 't',
        fetch: (async () => res) as unknown as typeof fetch,
      });
      await expect(bad('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    }
  });
});

describe('brainRegistry backoff', () => {
  it('keeps a failure a moment, doubling, instead of asking the brain on every call', async () => {
    let t = 0;
    let asked = 0;
    let up = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = (async () => {
      asked += 1;
      if (!up) throw new TypeError('fetch failed');
      return ok({ services: [svc] });
    }) as unknown as typeof fetch;
    const lookup = brainRegistry({ url: 'u', token: 't', fetch: f, now: () => t });
    await expect(lookup('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    for (let i = 0; i < 50; i++) {
      await expect(lookup('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    }
    expect(asked).toBe(1);
    t = 1_000; // the first backoff is over: asked again, still down
    await expect(lookup('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    expect(asked).toBe(2);
    t = 2_500; // the second backoff (2 s) is not over yet
    await expect(lookup('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    expect(asked).toBe(2);
    up = true;
    t = 3_000;
    expect(await lookup('billing')).toEqual(svc);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('counts one failed read once, however many callers wait on it', async () => {
    let t = 0;
    let asked = 0;
    let answer = () => {};
    const answered = new Promise<void>((r) => (answer = r));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = (async () => {
      asked += 1;
      await answered;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const lookup = brainRegistry({ url: 'u', token: 't', fetch: f, now: () => t });
    const waiting = Array.from({ length: 6 }, () => lookup('billing'));
    answer();
    for (const got of await Promise.allSettled(waiting)) {
      expect(got.status).toBe('rejected');
      expect((got as PromiseRejectedResult).reason).toBeInstanceOf(RegistryUnavailable);
    }
    expect(asked).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    t = 999; // still the first backoff, 1 s
    await expect(lookup('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    expect(asked).toBe(1);
    t = 1_000; // over: one failure, so one step, not one per caller
    await expect(lookup('billing')).rejects.toBeInstanceOf(RegistryUnavailable);
    expect(asked).toBe(2);
    warn.mockRestore();
  });

  it('never follows a redirect with the token, and names a token mismatch', async () => {
    const inits: RequestInit[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = (async (_u: unknown, init?: RequestInit) => {
      inits.push(init!);
      return new Response('no', { status: 401 });
    }) as unknown as typeof fetch;
    const lookup = brainRegistry({ url: 'u', token: 't', fetch: f });
    await expect(lookup('billing')).rejects.toThrow(/GATEWAY_TOKEN differs/);
    expect(inits[0]!.redirect).toBe('error');
    const shipped: RequestInit[] = [];
    const s = callShipper({
      url: 'u',
      token: 't',
      fetch: (async (_u: unknown, init?: RequestInit) => {
        shipped.push(init!);
        return ok({});
      }) as unknown as typeof fetch,
    });
    s.add(row(1));
    await s.flush();
    expect(shipped[0]!.redirect).toBe('error');
    warn.mockRestore();
  });
});

const row = (i: number): GatewayCallEntry => ({
  serviceSlug: 'billing',
  method: 'POST',
  path: `/mcp/${i}`,
  status: 200,
  requestBytes: 1,
  responseBytes: 2,
  durationMs: 3,
  caller: 'agent:a',
  loginId: null,
  refusal: null,
});

describe('callShipper', () => {
  it('sends rows in batches, in the background', async () => {
    const batches: unknown[][] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      batches.push(JSON.parse(String(init?.body)).calls);
      return ok({});
    }) as unknown as typeof fetch;
    const s = callShipper({
      url: 'http://web:3000',
      token: 't',
      fetch: f,
      maxBatch: 2,
      flushMs: 10,
    });
    for (let i = 0; i < 5; i++) s.add(row(i));
    await s.flush();
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('drops a batch the brain does not take, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const s = callShipper({ url: 'u', token: 't', fetch: f, maxBuffer: 3 });
    for (let i = 0; i < 5; i++) s.add(row(i));
    await expect(s.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('brainFetch', () => {
  const cidrs = [parseCidr('172.31.250.0/24')!];
  const seen: string[] = [];
  const f = (async (u: string | URL) => {
    seen.push(String(u));
    return ok({ services: [] });
  }) as unknown as typeof fetch;
  const dns = (map: Record<string, string[]>) => async (h: string) => {
    if (!(h in map)) throw new Error('ENOTFOUND');
    return map[h]!;
  };

  it("connects to the brain's checked address, not its name", async () => {
    seen.length = 0;
    const go = brainFetch(cidrs, dns({ web: ['172.18.0.4'] }), f);
    await go('http://web:3000/api/gateway/registry');
    expect(seen).toEqual(['http://172.18.0.4:3000/api/gateway/registry']);
  });

  it('refuses a brain name that resolves onto the services network (an alias), or not at all', async () => {
    seen.length = 0;
    const alias = brainFetch(cidrs, dns({ web: ['172.31.250.9'] }), f);
    await expect(alias('http://web:3000/x')).rejects.toThrow(/services network/);
    const mixed = brainFetch(cidrs, dns({ web: ['172.18.0.4', '172.31.250.9'] }), f);
    await expect(mixed('http://web:3000/x')).rejects.toBeInstanceOf(RegistryUnavailable);
    const literal = brainFetch(cidrs, dns({}), f);
    await expect(literal('http://172.31.250.9:3000/x')).rejects.toThrow(/services network/);
    await expect(literal('http://web:3000/x')).rejects.toThrow(/does not resolve/);
    expect(seen).toEqual([]);
  });

  it('fails the registry closed, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = brainRegistry({
      url: 'http://web:3000',
      token: 't',
      fetch: brainFetch(cidrs, dns({ web: ['172.31.250.9'] }), f),
    });
    await expect(lookup('pcms')).rejects.toThrow(/services network/);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/services network/);
    warn.mockRestore();
  });
});
