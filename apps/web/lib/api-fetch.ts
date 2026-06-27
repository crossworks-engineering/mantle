/**
 * Client-side fetch helper for the `/api/**` surface — the single data transport
 * for the detached frontend (Phase 2 · Task 4 / DB-less dev).
 *
 * Same-origin by default: relative URL + cookie auth, exactly as today. When
 * `NEXT_PUBLIC_MANTLE_API_BASE` is set (Electron, or a detached/DB-less browser
 * client) it targets that origin and attaches the `NEXT_PUBLIC_MANTLE_API_TOKEN`
 * bearer — since cross-origin requests can't rely on the session cookie. In that
 * detached mode the browser talks straight to the remote API, so the local Next
 * server needs no database (see `detachedDevUser` in lib/auth + docs/db-less-dev.md).
 *
 * Throws an `ApiError` carrying the endpoint's `{ error }` message on non-2xx so
 * TanStack Query surfaces it in `error` / `onError`.
 */

const API_BASE = (process.env.NEXT_PUBLIC_MANTLE_API_BASE ?? '').replace(/\/+$/, '');
const API_TOKEN = process.env.NEXT_PUBLIC_MANTLE_API_TOKEN ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function withAuth(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (API_BASE && API_TOKEN && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${API_TOKEN}`);
  }
  return {
    // Same-origin cookie auth in the normal case; harmless cross-origin.
    credentials: 'include',
    ...init,
    headers,
  };
}

/**
 * Auth failure as seen by a *client* fetch. Two shapes, because routes gate two
 * ways: `getOwnerOr401` → JSON 401, and `requireOwner` → 307 to /login that
 * `fetch` silently follows (landing on the login HTML, 200). Without this, an
 * expired session would parse as `{}` and render an empty screen instead of
 * bouncing to login — a trap every converted screen would otherwise inherit.
 */
function isAuthFailure(res: Response): boolean {
  if (res.status === 401) return true;
  if (res.redirected) {
    try {
      return new URL(res.url).pathname.startsWith('/login');
    } catch {
      return false;
    }
  }
  return false;
}

/** Send the browser to login, preserving where we were. No-op on the server or
 *  if we're already on the login screen (avoids a redirect loop). */
function bounceToLogin(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname.startsWith('/login')) return;
  const next = window.location.pathname + window.location.search;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

/** Fetch a JSON resource, returning the parsed body or throwing `ApiError`. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, withAuth(init));
  if (isAuthFailure(res)) {
    bounceToLogin();
    throw new ApiError('unauthorized', 401);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

/**
 * Open an SSE stream over the `/api/**` surface — the EventSource replacement
 * for a detached client. `EventSource` can't set an `Authorization` header or
 * honor `NEXT_PUBLIC_MANTLE_API_BASE`, so it's cookie/same-origin only; this
 * fetch-based reader carries the base-URL + bearer exactly like `apiFetch`.
 *
 * Calls `onMessage` once per `data:` frame (comments `:`/keep-alives are
 * skipped); a throwing `onMessage` is routed to `onError` without dropping the
 * connection. Auto-reconnects with exponential backoff + jitter on a
 * dropped/closed connection, mirroring EventSource — but stops (and bounces to
 * /login) on an auth failure. Returns a disposer; call it on unmount to close
 * the stream.
 */
export function apiEventStream(
  path: string,
  onMessage: (data: string) => void,
  opts?: { onError?: (err: unknown) => void },
): () => void {
  const controller = new AbortController();
  let closed = false;
  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        const res = await fetch(
          `${API_BASE}${path}`,
          withAuth({ signal: controller.signal, headers: { Accept: 'text/event-stream' } }),
        );
        if (isAuthFailure(res)) {
          bounceToLogin();
          return; // auth failure won't self-heal — don't reconnect.
        }
        if (!res.ok || !res.body) throw new ApiError(`stream failed (${res.status})`, res.status);

        attempt = 0; // connected — reset backoff.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Frames are separated by a blank line; flush each complete one.
          let sep: number;
          while ((sep = buf.search(/\r\n\r\n|\n\n/)) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2));
            const data = frame
              .split(/\r\n|\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).replace(/^ /, ''))
              .join('\n');
            if (data) {
              // A throwing consumer is a consumer bug, not a connection fault —
              // route it to onError but keep reading; never let it reach the
              // outer catch (which would treat it as a drop and reconnect).
              try {
                onMessage(data);
              } catch (cbErr) {
                opts?.onError?.(cbErr);
              }
            }
          }
        }
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        opts?.onError?.(err);
      }
      if (closed) return;
      attempt += 1;
      // Exponential backoff with full-ish jitter: a synchronously-failing
      // endpoint doesn't get hammered ~1×/s, and a deploy/restart doesn't make
      // every tab reconnect in lockstep (thundering herd). Resets to 0 above on
      // a successful connect.
      const ceiling = Math.min(30_000, 1000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, ceiling * (0.5 + Math.random() * 0.5)));
    }
  };

  void run();
  return () => {
    closed = true;
    controller.abort();
  };
}

/** POST/PATCH/DELETE JSON helper — sets the content-type + serializes the body. */
export function apiSend<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  return apiFetch<T>(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
