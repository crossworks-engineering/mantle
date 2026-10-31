/**
 * The `undici` package, and a fetch through one of its dispatchers, on every
 * runtime. egress.ts pins a connection with a dispatcher, and
 * provider-fetch.ts and tailnet.ts route with one.
 *
 * Bun needs its own path, because two things there fail with no error. The
 * name `undici` loads a stand-in whose Agent has no lookup and no close, and
 * the built-in fetch ignores `dispatcher`. A pin would be gone and a proxied
 * call would go direct. So on Bun the package loads from its own file, and
 * undici's own fetch runs the call.
 *
 * `undici` is Node-only (it pulls in node:net) and this module can reach a
 * browser bundle, so it loads lazily, through `process.getBuiltinModule` (no
 * static import for a bundler to follow).
 */

type Undici = typeof import('undici');
type Dispatcher = import('undici').Dispatcher;

let undiciModule: Undici | null | undefined; // undefined = not tried; null = unavailable

/** The `undici` package, or null where it cannot load (a browser bundle). */
export function loadUndici(): Undici | null {
  if (undiciModule !== undefined) return undiciModule;
  try {
    const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);
    undiciModule = (
      process.versions.bun
        ? load(load.resolve('undici/package.json').replace(/package\.json$/, 'index.js'))
        : load('undici')
    ) as Undici;
  } catch {
    undiciModule = null;
  }
  return undiciModule;
}

/**
 * A call through undici's own fetch. It knows only its own Request and
 * FormData classes, so those go in as parts. The answer comes back as the
 * runtime's Response, so a caller's `instanceof Response` holds.
 */
async function undiciFetch(
  undici: Undici,
  input: RequestInfo | URL,
  init: RequestInit,
  dispatcher: Dispatcher,
): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const headers = new Headers(init.headers ?? req?.headers);
  let body = init.body === undefined ? req?.body : init.body;
  if (body instanceof FormData) {
    const form = new Response(body);
    headers.set('content-type', form.headers.get('content-type') ?? '');
    body = await form.arrayBuffer();
  }
  const res = await undici.fetch(req?.url ?? input.toString(), {
    method: req?.method,
    signal: req?.signal,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    ...init,
    headers: [...headers],
    body,
    dispatcher,
  } as import('undici').RequestInit);
  const out = new Response(res.body as BodyInit | null, {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
  });
  Object.defineProperty(out, 'url', { value: res.url });
  return out;
}

/**
 * `platformFetch` through `dispatcher`, or undici's own fetch on Bun. A
 * `platformFetch` written in JavaScript (a test stub, even one set before
 * this module loaded) is called as it is, as on Node. Bun's own fetch is
 * native code; anything that is not a function of ours takes undici's path,
 * so the pin holds when in doubt.
 */
export function fetchThrough(
  dispatcher: Dispatcher,
  input: RequestInfo | URL,
  init: RequestInit,
  platformFetch: typeof fetch,
): Promise<Response> {
  const native = Function.prototype.toString.call(platformFetch).includes('[native code]');
  const undici = process.versions.bun && native ? loadUndici() : null;
  if (undici) return undiciFetch(undici, input, init, dispatcher);
  // The built-in RequestInit type has no `dispatcher`; the runtime accepts it.
  return platformFetch(input, { ...init, dispatcher } as RequestInit);
}
