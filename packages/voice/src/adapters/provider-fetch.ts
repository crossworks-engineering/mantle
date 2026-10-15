/**
 * The one HTTP pool for model-provider calls (chat, embeddings, vision,
 * image, speech, the decisions judge).
 *
 * Why: Node 26's built-in fetch (bundled undici 8.7) negotiates HTTP/2 with a
 * TLS provider and then, on a warm HTTP/2 session, sends non-idempotent
 * requests (POST, PUT) ONE AT A TIME. GET is not affected, plain http is not
 * affected, and a cold first batch is not affected (each request opens its own
 * connection before the session exists), which is why it hid. Every provider
 * call is a POST, so N parallel calls to one provider took N request times
 * (8 POSTs of 300 ms: 2.4 s; measured 2026-10-04, see
 * docs/provider-http.md). The `undici` package (8.10) has no such limit, and
 * its Agent can be handed to the built-in fetch as `dispatcher`, so the
 * Request/Response objects stay native.
 *
 * The pool: one Agent (one connection pool per origin), HTTP/1.1 keep-alive,
 * at most {@link PROVIDER_CONNECTIONS} connections per origin. The cap is a
 * ceiling, not a driver: callers still decide how many requests they send.
 *
 * Deadlines (A10 #10): every call has one. The caller names it
 * (`{ timeoutMs: PROVIDER_TIMEOUTS.discover }`, @mantle/std timeouts.ts);
 * a call that names none gets `PROVIDER_TIMEOUTS.default` (180 s). It covers
 * the whole exchange of an ordinary answer, and only the headers of an event
 * stream (`text/event-stream`, or `timeoutScope: 'headers'`), so a long
 * healthy stream is never cut: the stream's own idle guard (sse.ts) bounds
 * it after that. Before, a call with no signal waited on undici's defaults
 * only (300 s for the headers, 300 s of body silence, no total).
 *
 * `undici` is Node-only (it pulls in node:net) and the `@mantle/voice` barrel
 * reaches browser bundles, so it is loaded lazily. The server runs as ESM,
 * where a bare `require` does not exist, so the loader comes from
 * `process.getBuiltinModule` (no static import for a bundler to follow).
 * Where it cannot load (a browser), the plain built-in fetch is used.
 *
 * A replaced global fetch (a test stub) still wins, untouched.
 */

import { PROVIDER_TIMEOUTS, formatMs } from '@mantle/std';

type Undici = typeof import('undici');
type UndiciAgent = import('undici').Agent;
type UndiciProxyAgent = import('undici').ProxyAgent;

/** Connections per provider origin. */
export const PROVIDER_CONNECTIONS = 32;

const NATIVE_FETCH = globalThis.fetch;

let undiciModule: Undici | null | undefined; // undefined = not tried; null = unavailable
let agent: UndiciAgent | null | undefined;
let testConnect: { ca: string } | undefined;

/** The `undici` package, or null where it cannot load (a browser bundle). */
export function loadUndici(): Undici | null {
  if (undiciModule !== undefined) return undiciModule;
  try {
    const nodeModule = process.getBuiltinModule('node:module');
    const load = nodeModule.createRequire(import.meta.url);
    undiciModule = load('undici') as Undici;
  } catch {
    undiciModule = null;
  }
  return undiciModule;
}

/** Agent options shared by the direct pool and the tailnet proxy pool. */
export function providerAgentOptions(): {
  allowH2: false;
  connections: number;
  keepAliveTimeout: number;
} {
  return { allowH2: false, connections: PROVIDER_CONNECTIONS, keepAliveTimeout: 10_000 };
}

/** The shared provider Agent, or null where `undici` is unavailable. */
export function providerDispatcher(): UndiciAgent | null {
  if (agent !== undefined) return agent;
  const undici = loadUndici();
  agent = undici
    ? new undici.Agent({
        ...providerAgentOptions(),
        ...(testConnect ? { connect: testConnect } : {}),
      })
    : null;
  return agent;
}

/** A provider call's deadline. */
export type ProviderFetchOptions = {
  /** Abort after this many ms (name it from PROVIDER_TIMEOUTS). Default
   *  PROVIDER_TIMEOUTS.default. */
  timeoutMs?: number;
  /**
   * What the deadline covers. `exchange`: the headers and the body. `headers`:
   * the first byte only (a stream). `auto` (default): the exchange, unless the
   * answer is an event stream, then the headers only.
   */
  timeoutScope?: 'exchange' | 'headers' | 'auto';
};

function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

/**
 * Fetch through a given undici dispatcher with the built-in fetch (native
 * Request/Response), under the call's deadline. A replaced global fetch (a
 * test stub) still wins, untouched: it gets the caller's init as given.
 */
export async function fetchVia(
  dispatcher: UndiciAgent | UndiciProxyAgent | null,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: ProviderFetchOptions,
): Promise<Response> {
  if (globalThis.fetch !== NATIVE_FETCH) return globalThis.fetch(input, init);
  const ms = opts?.timeoutMs ?? PROVIDER_TIMEOUTS.default;
  const scope = opts?.timeoutScope ?? 'auto';
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException(`provider call timed out after ${formatMs(ms)}`, 'TimeoutError'),
      ),
    ms,
  );
  (timer as { unref?: () => void }).unref?.();
  const own = [init?.signal, input instanceof Request ? input.signal : null].filter(
    (s): s is AbortSignal => !!s,
  );
  const signal = own.length ? AbortSignal.any([...own, deadline.signal]) : deadline.signal;
  // The built-in RequestInit type has no `dispatcher`; the runtime accepts it.
  const next = { ...init, signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit;
  let res: Response;
  try {
    res = await NATIVE_FETCH(input, next);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  if (scope === 'headers' || (scope === 'auto' && isEventStream(res))) clearTimeout(timer);
  return res;
}

/** Drop-in for `fetch` on every model-provider call, with a deadline. */
export function providerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: ProviderFetchOptions,
): Promise<Response> {
  return fetchVia(providerDispatcher(), input, init, opts);
}

/**
 * Test seam: drop the shared Agent so the next call builds a new one; `ca`
 * lets the next one trust a test server's self-signed certificate.
 */
export function _resetProviderDispatcher(ca?: string): void {
  void agent?.close().catch(() => {});
  agent = undefined;
  testConnect = ca ? { ca } : undefined;
}
