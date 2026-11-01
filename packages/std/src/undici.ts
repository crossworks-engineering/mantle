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

/** Cancels undici's stream when the caller's stream is collected unread. */
const unread = new FinalizationRegistry<ReadableStreamDefaultReader<Uint8Array>>((reader) => {
  void reader.cancel().catch(() => {});
});

/**
 * undici's stream as one the caller owns. The reader takes undici's stream at
 * once: undici cancels an unread stream when its own Response is collected, and
 * that one is gone when undiciFetch returns. In exchange a stream the caller
 * drops unread must be cancelled here, or its connection stays open until the
 * idle limit.
 */
function callerStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const own = new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      },
      cancel: (why) => reader.cancel(why),
    },
    { highWaterMark: 0 },
  );
  unread.register(own, reader);
  return own;
}

/** A Request's body as bytes. An abort stops the read and cancels the body, so
 *  a producer that stalls hears of it. */
async function requestBytes(req: Request, signal?: AbortSignal | null): Promise<ArrayBuffer> {
  if (!signal || !req.body) return req.arrayBuffer();
  const reader = req.body.getReader();
  const stop = () => void reader.cancel(signal.reason).catch(() => {});
  if (signal.aborted) stop();
  signal.throwIfAborted();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return await new Blob(parts).arrayBuffer();
      parts.push(value);
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/**
 * A call through undici's own fetch. It knows only its own Request and
 * FormData classes, so those go in as parts, and a Request's body goes in as
 * bytes, so it keeps its length. The answer comes back as the runtime's
 * Response, so a caller's `instanceof Response` holds.
 */
async function undiciFetch(
  undici: Undici,
  input: RequestInfo | URL,
  init: RequestInit,
  dispatcher: Dispatcher,
): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const headers = new Headers(init.headers ?? req?.headers);
  let body = init.body;
  if (body === undefined && req?.body) body = await requestBytes(req, init.signal ?? req.signal);
  if (body instanceof FormData) {
    const form = new Response(body);
    headers.set('content-type', form.headers.get('content-type') ?? '');
    body = await form.arrayBuffer();
  }
  const res = await undici.fetch(req?.url ?? input.toString(), {
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    ...init,
    method: init.method ?? req?.method,
    signal: init.signal ?? req?.signal,
    redirect: init.redirect ?? req?.redirect,
    headers: [...headers],
    body,
    dispatcher,
  } as import('undici').RequestInit);
  const stream = res.body as unknown as ReadableStream<Uint8Array> | null;
  const out = new Response(stream && callerStream(stream), {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
  });
  Object.defineProperty(out, 'url', { value: res.url });
  return out;
}

/**
 * `platformFetch` through `dispatcher`, or undici's own fetch on Bun. Bun's
 * fetch is native code. One written in JavaScript is a test stub (even one set
 * before this module loaded) and is called as on Node. Outside a test it is a
 * wrapper that would hand the dispatcher to Bun's fetch and lose it, so it is
 * refused: a dropped pin must not pass in silence.
 */
export function fetchThrough(
  dispatcher: Dispatcher,
  input: RequestInfo | URL,
  init: RequestInit,
  platformFetch: typeof fetch,
): Promise<Response> {
  const native = Function.prototype.toString.call(platformFetch).includes('[native code]');
  if (process.versions.bun && !native && !fetchStubsApply()) {
    throw new Error('fetch is wrapped: on Bun a wrapper would drop the dispatcher');
  }
  const undici = process.versions.bun && native ? loadUndici() : null;
  if (undici) return undiciFetch(undici, input, init, dispatcher);
  // The built-in RequestInit type has no `dispatcher`; the runtime accepts it.
  return platformFetch(input, { ...init, dispatcher } as RequestInit);
}

/** True in a test run: a replaced global fetch is then a stub, not a wrapper. */
export function fetchStubsApply(): boolean {
  return process.env.NODE_ENV === 'test';
}
