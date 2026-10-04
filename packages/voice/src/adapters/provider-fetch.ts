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
 * Timeouts stay at undici's defaults (the same as the built-in fetch), since a
 * slow local model may take minutes for its first byte.
 *
 * `undici` is Node-only (it pulls in node:net) and the `@mantle/voice` barrel
 * reaches browser bundles, so it is loaded lazily. The server runs as ESM,
 * where a bare `require` does not exist, so the loader comes from
 * `process.getBuiltinModule` (no static import for a bundler to follow).
 * Where it cannot load (a browser), the plain built-in fetch is used.
 *
 * A replaced global fetch (a test stub) still wins, untouched.
 */

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

/**
 * Fetch through a given undici dispatcher with the built-in fetch (native
 * Request/Response). A replaced global fetch (a test stub) still wins.
 */
export function fetchVia(
  dispatcher: UndiciAgent | UndiciProxyAgent | null,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (globalThis.fetch !== NATIVE_FETCH) return globalThis.fetch(input, init);
  if (!dispatcher) return NATIVE_FETCH(input, init);
  // The built-in RequestInit type has no `dispatcher`; the runtime accepts it.
  return NATIVE_FETCH(input, { ...init, dispatcher } as RequestInit);
}

/** Drop-in for `fetch` on every model-provider call. */
export function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetchVia(providerDispatcher(), input, init);
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
