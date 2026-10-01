/**
 * One Server-Sent Events response (audit M1): the stream shell the owner and
 * member realtime routes shared by copy. Opens with a comment so EventSource
 * fires `open`, sends a keep-alive comment every `heartbeatMs` so proxies do
 * not reap an idle connection, and cleans up exactly once, however it ends
 * (the client leaves, `onPing` says stop, or `maxLifetimeMs` runs out).
 */

export type SseSend = (data: unknown) => void;

export type SseOptions = {
  /** Start listening; `send` writes one `data:` event. Returns the unsubscribe. */
  subscribe: (send: SseSend) => Promise<() => void>;
  /** Called on each heartbeat: false closes the stream (e.g. the caller's
   *  login is no longer valid). */
  onPing?: () => Promise<boolean> | boolean;
  /** Close the stream after this long; EventSource reconnects on its own, so
   *  a long-lived stream re-authenticates. */
  maxLifetimeMs?: number;
  heartbeatMs?: number;
  /** Runs once when the stream ends, for any reason. */
  onClose?: () => void;
};

export function sseResponse(req: Request, opts: SseOptions): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (lifetime) clearTimeout(lifetime);
    heartbeat = null;
    lifetime = null;
    unsubscribe?.();
    unsubscribe = null;
    opts.onClose?.();
  };

  /** End from the server side: close the stream, then clean up. */
  const end = () => {
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
    cleanup();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      const enc = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* stream already closed */
        }
      };
      enc(': connected\n\n');
      const off = await opts.subscribe((data) => enc(`data: ${JSON.stringify(data)}\n\n`));
      // The client may have left while we subscribed.
      if (closed) {
        off();
        return;
      }
      unsubscribe = off;
      heartbeat = setInterval(() => {
        void (async () => {
          const keep = opts.onPing ? await Promise.resolve(opts.onPing()).catch(() => false) : true;
          if (!keep) end();
          else enc(': ping\n\n');
        })();
      }, heartbeatMs);
      if (opts.maxLifetimeMs) lifetime = setTimeout(end, opts.maxLifetimeMs);
    },
    cancel() {
      cleanup();
    },
  });

  // The client navigated away or closed the tab.
  req.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}
