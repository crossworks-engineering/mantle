/**
 * A fake network for the egress proof tables (A10 part 1, docs/egress.md):
 * test support, never imported by product code.
 *
 * It stands in for the two things an outbound fetch touches outside the
 * process: DNS (`node:dns/promises` lookup, mocked per test file) and the
 * platform fetch (stubbed on globalThis). Hosts are named per proof cell, so
 * a caller that appends its own path still lands on the cell's behaviour.
 * The platform's redirect modes are copied as Node 26 (undici 8) runs them,
 * checked against two loopback servers: `follow` keeps custom headers on a
 * cross-origin hop and drops only Authorization, Cookie and
 * Proxy-Authorization; `manual` hands the 3xx back; `error` throws a
 * TypeError ("fetch failed").
 */

/** What one host answers, for any path. */
export type HostReply =
  | { kind: 'ok'; body: string; contentType: string }
  | { kind: 'redirect'; to: string }
  | { kind: 'huge'; bytes: number }
  | { kind: 'hang' };

export type TestNetHost = { ip: string; reply: HostReply };

export type TestNetRequest = { host: string; method: string; headers: Record<string, string> };

const CHUNK = 64 * 1024;
const MAX_FOLLOW = 20;

/** The proof cells (the brief's URL list), in table order. */
export const EGRESS_CELLS = [
  'public host',
  'private IP',
  'name resolving to 127.0.0.1',
  'redirect to 169.254.169.254',
  'redirect to another host with Authorization',
  'oversized body',
  'slow server',
] as const;
export type EgressCell = (typeof EGRESS_CELLS)[number];

/** The base URL (no trailing slash) each cell sends a caller to. */
export const EGRESS_CELL_URLS: Record<EgressCell, string> = {
  'public host': 'https://public.test',
  'private IP': 'http://10.0.0.5',
  'name resolving to 127.0.0.1': 'http://inside.test',
  'redirect to 169.254.169.254': 'https://meta-redirect.test',
  'redirect to another host with Authorization': 'https://cross-redirect.test',
  'oversized body': 'https://huge.test',
  'slow server': 'https://slow.test',
};

/** The size of the oversized body: over every cap in the tables (the
 *  largest is the peer client's 32 MB). */
export const HUGE_BYTES = 33 * 1024 * 1024;

/** The fake network for one caller row: `okBody` is what a reachable host
 *  answers (a feed, peer JSON, plain text). */
export function egressTestHosts(okBody: string, contentType: string): Record<string, TestNetHost> {
  const ok: HostReply = { kind: 'ok', body: okBody, contentType };
  return {
    'public.test': { ip: '93.184.216.34', reply: ok },
    '10.0.0.5': { ip: '10.0.0.5', reply: ok },
    'inside.test': { ip: '127.0.0.1', reply: ok },
    'meta-redirect.test': {
      ip: '93.184.216.36',
      reply: { kind: 'redirect', to: 'http://169.254.169.254/latest/meta-data/' },
    },
    'cross-redirect.test': {
      ip: '93.184.216.37',
      reply: { kind: 'redirect', to: 'https://other.test/landing' },
    },
    'other.test': { ip: '93.184.216.35', reply: ok },
    '169.254.169.254': {
      ip: '169.254.169.254',
      reply: { kind: 'ok', body: 'METADATA-SECRET', contentType: 'text/plain' },
    },
    'huge.test': { ip: '93.184.216.38', reply: { kind: 'huge', bytes: HUGE_BYTES } },
    'slow.test': { ip: '93.184.216.39', reply: { kind: 'hang' } },
  };
}

export type TestNet = {
  fetch: typeof fetch;
  lookup: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Every request the network saw, in order. */
  log: TestNetRequest[];
  /** Bytes a reader pulled from the oversized body. */
  hugeBytesPulled: () => number;
};

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h ?? {}).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** A network of `hosts`. */
export function createTestNet(hosts: Record<string, TestNetHost>): TestNet {
  const log: TestNetRequest[] = [];
  let pulled = 0;

  const lookup = async (host: string) => {
    const h = hosts[host];
    if (!h) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return [{ address: h.ip, family: h.ip.includes(':') ? 6 : 4 }];
  };

  const answer = (url: URL, signal: AbortSignal | null | undefined): Promise<Response> => {
    const h = hosts[url.hostname.replace(/^\[|\]$/g, '')];
    if (!h) return Promise.reject(new TypeError('fetch failed'));
    const r = h.reply;
    if (r.kind === 'ok') {
      return Promise.resolve(
        new Response(r.body, { status: 200, headers: { 'content-type': r.contentType } }),
      );
    }
    if (r.kind === 'redirect') {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: r.to } }));
    }
    if (r.kind === 'huge') {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (sent >= r.bytes) {
            ctrl.close();
            return;
          }
          const n = Math.min(CHUNK, r.bytes - sent);
          sent += n;
          pulled += n;
          ctrl.enqueue(new Uint8Array(n).fill(97));
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    }
    // hang: never answers; an abort rejects with the signal's reason.
    return new Promise((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    let url = new URL(req ? req.url : input instanceof URL ? input.toString() : String(input));
    let method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    let headers = headerRecord(init?.headers ?? req?.headers);
    const mode = init?.redirect ?? req?.redirect ?? 'follow';
    const signal = init?.signal ?? req?.signal;
    if (signal?.aborted) throw signal.reason;
    for (let hop = 0; ; hop++) {
      log.push({ host: url.hostname, method, headers: { ...headers } });
      const res = await answer(url, signal);
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return res;
      if (mode === 'manual') return res;
      if (mode === 'error') throw new TypeError('fetch failed');
      if (hop >= MAX_FOLLOW) throw new TypeError('fetch failed');
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        for (const k of ['authorization', 'cookie', 'proxy-authorization']) delete headers[k];
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-/.test(k)));
      }
      url = next;
    }
  }) as typeof fetch;

  return { fetch: fakeFetch, lookup, log, hugeBytesPulled: () => pulled };
}

/** The network the mocked DNS module answers from (one per running row). */
let active: TestNet | null = null;

/** Point the mocked `node:dns/promises` at `net`. */
export function useTestNet(net: TestNet | null): void {
  active = net;
}

/** The module a test file hands `vi.mock('node:dns/promises', ...)`. */
export const testNetDnsModule = (() => {
  const lookup = (host: string) => {
    if (!active) throw new Error('egress test net: no network is active');
    return active.lookup(host);
  };
  return { lookup, default: { lookup } };
})();

/** One row's answer for one cell, flattened for a JSON snapshot. */
export type EgressCellResult = {
  /** The caller's answer, short. */
  answer: string;
  /** Hosts the caller reached, in order. */
  reached: string[];
  /** Whether the other host of the cross-host cell saw Authorization. */
  authorizationAtOtherHost?: 'sent' | 'not sent' | 'other host not reached';
  /** How much of the oversized body was read, in whole MB. */
  oversizedRead?: string;
};

/** Fake-timer hooks (vitest's `vi`), passed in so this file needs no
 *  test runner. */
export type FakeTimers = {
  useFakeTimers: () => void;
  useRealTimers: () => void;
  advanceTimersByTimeAsync: (ms: number) => Promise<unknown>;
};

/** How long the slow cell waits (fake time) before it calls a caller
 *  "still waiting". */
const SLOW_LIMIT_MS = 10 * 60 * 1000;
const SLOW_STEP_MS = 1000;

/**
 * Run one caller over every cell. `call(baseUrl)` runs the caller for a
 * cell's base URL and returns its short answer; it must not throw (map an
 * error to `error: <message>`). `stubFetch` installs the net's fetch on
 * globalThis (the caller's tests own their stubbing).
 */
export async function runEgressRow(
  okBody: string,
  contentType: string,
  call: (baseUrl: string) => Promise<string>,
  hooks: { stubFetch: (f: typeof fetch) => void; timers: FakeTimers },
): Promise<Record<EgressCell, EgressCellResult>> {
  const out = {} as Record<EgressCell, EgressCellResult>;
  for (const cell of EGRESS_CELLS) {
    const net = createTestNet(egressTestHosts(okBody, contentType));
    useTestNet(net);
    hooks.stubFetch(net.fetch);
    let answer: string;
    if (cell === 'slow server') {
      hooks.timers.useFakeTimers();
      // AbortSignal.timeout runs on a timer fake timers do not reach: make
      // it a plain setTimeout for the cell so a caller's own deadline fires.
      const realTimeout = AbortSignal.timeout;
      AbortSignal.timeout = (ms: number) => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException('timed out', 'TimeoutError')), ms);
        return c.signal;
      };
      try {
        let settled: string | null = null;
        const started = Date.now();
        void call(EGRESS_CELL_URLS[cell]).then((a) => {
          settled = `${a} (after ${Math.round((Date.now() - started) / 1000)} s)`;
        });
        for (let t = 0; t < SLOW_LIMIT_MS && settled === null; t += SLOW_STEP_MS) {
          await hooks.timers.advanceTimersByTimeAsync(SLOW_STEP_MS);
        }
        answer = settled ?? `still waiting after ${SLOW_LIMIT_MS / 1000} s`;
      } finally {
        AbortSignal.timeout = realTimeout;
        hooks.timers.useRealTimers();
      }
    } else {
      answer = await call(EGRESS_CELL_URLS[cell]);
    }
    const r: EgressCellResult = { answer, reached: net.log.map((l) => l.host) };
    if (cell === 'redirect to another host with Authorization') {
      const at = net.log.find((l) => l.host === 'other.test');
      r.authorizationAtOtherHost = !at
        ? 'other host not reached'
        : at.headers.authorization
          ? 'sent'
          : 'not sent';
    }
    if (cell === 'oversized body') {
      const n = net.hugeBytesPulled();
      r.oversizedRead =
        n >= HUGE_BYTES
          ? 'whole body'
          : n === 0
            ? 'not read'
            : `stopped at ${Math.round(n / (1024 * 1024))} MB`;
    }
    out[cell] = r;
    useTestNet(null);
  }
  return out;
}

/** Short form of an error for a table cell. */
export function cellError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return `error: ${m.slice(0, 160)}`;
}
