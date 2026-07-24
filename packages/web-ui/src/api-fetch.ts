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

import { runtimeApiBase } from './runtime-env';
import { tokenStore } from './token-store';

/** API base + bearer are GETTERS, not module constants: the split client
 *  resolves them at call time from window.__MANTLE_ENV__ (runtime config) and
 *  the token store (login-issued bearer). Build-time NEXT_PUBLIC_* vars remain
 *  the fallback, so the monolith and detached dev behave exactly as before. */
function apiBaseValue(): string {
  return runtimeApiBase();
}
function apiTokenValue(): string {
  return tokenStore.get() ?? process.env.NEXT_PUBLIC_MANTLE_API_TOKEN ?? '';
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Resolve a path against the configured API base — the remote origin in
 *  detached/Electron mode, same-origin (empty base) otherwise. For raw `fetch()`
 *  calls that must own their own `Response` handling and so can't go through
 *  `apiFetch` (e.g. the assistant turn POST's re-attach loop, the stage poller). */
export function apiUrl(path: string): string {
  return `${apiBaseValue()}${path}`;
}

/** Build a `RequestInit` carrying same-origin cookie auth, plus the bearer +
 *  base-URL when detached. Exported for the raw-`fetch()` callers above; most
 *  code should use `apiFetch`/`apiSend` instead. */
export function withAuth(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (apiBaseValue() && apiTokenValue() && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${apiTokenValue()}`);
  }
  return {
    // Same-origin: cookie auth. Detached (apiBaseValue() set): bearer-only, so send
    // NO credentials — the middleware's CORS reflects the origin WITHOUT
    // Allow-Credentials (by design; see corsOrigin), and the browser refuses a
    // credentialed cross-origin response that lacks it.
    credentials: apiBaseValue() ? 'omit' : 'include',
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
 * (Exported for team-fetch, whose 401 policy differs but whose detection
 * doesn't.)
 */
export function isAuthFailure(res: Response): boolean {
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
  // A dead/revoked bearer won't heal — clear it (and the presence cookie) so
  // the client middleware can't redirect-loop a logged-out page load.
  tokenStore.clear();
  const next = window.location.pathname + window.location.search;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

/** Fetch a JSON resource, returning the parsed body or throwing `ApiError`. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseValue()}${path}`, withAuth(init));
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
 *
 * **`Last-Event-ID` resume** (full EventSource parity): tracks each frame's `id:`
 * field and re-sends it as the `Last-Event-ID` header on every reconnect, so a
 * server that buffers events (e.g. the turn stream's `turn_stream_buffer`) can
 * replay exactly what was missed during the drop — no gap, no duplicate. Harmless
 * for streams that emit no `id:` or servers that ignore the header (it just
 * live-tails as before).
 */
export function apiEventStream(
  path: string,
  onMessage: (data: string) => void,
  opts?: { onError?: (err: unknown) => void },
): () => void {
  return eventStreamCore(
    (headers, signal) => fetch(`${apiBaseValue()}${path}`, withAuth({ signal, headers })),
    bounceToLogin,
    onMessage,
    opts,
  );
}

/**
 * The transport-agnostic SSE reader behind `apiEventStream` (owner surface)
 * and `teamEventStream` (member surface). The two differ only in how a
 * request is made (base + credential) and what an auth failure does
 * (bounceToLogin vs surface the token gate) — everything else (frame parsing,
 * Last-Event-ID resume, backoff+jitter reconnect, 404-silent-fallback) is
 * this loop. Exported for team-fetch; app code uses the bound wrappers.
 */
export function eventStreamCore(
  makeRequest: (headers: Record<string, string>, signal: AbortSignal) => Promise<Response>,
  onAuthFailure: () => void,
  onMessage: (data: string) => void,
  opts?: {
    onError?: (err: unknown) => void;
    /** Give up after this many CONSECUTIVE failed attempts (a successful
     *  connect resets the count) and call `onExhausted` instead of retrying
     *  forever. Consumers whose durable state can reconcile a missed ending
     *  (the team turn streams) use this so an outage can't strand a spinner;
     *  absent ⇒ the original reconnect-forever behavior (owner realtime). */
    maxAttempts?: number;
    onExhausted?: () => void;
  },
): () => void {
  const controller = new AbortController();
  let closed = false;
  let attempt = 0;
  // The last `id:` we successfully observed — resent on reconnect to resume.
  let lastEventId: string | null = null;

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (lastEventId !== null) headers['Last-Event-ID'] = lastEventId;
        const res = await makeRequest(headers, controller.signal);
        if (isAuthFailure(res)) {
          onAuthFailure();
          return; // auth failure won't self-heal — don't reconnect.
        }
        if (res.status === 404) {
          // The stream route doesn't exist — the feature is off server-side
          // (MANTLE_TURN_STREAMING=0). That won't self-heal, so fall back to the
          // non-streaming flow silently instead of reconnecting forever. This is
          // what lets the server be the single source of truth even though the
          // client gate is baked at build time.
          return;
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
            const lines = frame.split(/\r\n|\n/);
            const data = lines
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).replace(/^ /, ''))
              .join('\n');
            // Remember the event id for Last-Event-ID resume (EventSource parity).
            // Per the SSE spec an id containing a NUL is ignored; otherwise it
            // persists as the last id, even across later id-less events.
            const idLine = lines.find((l) => l.startsWith('id:'));
            if (idLine !== undefined) {
              const id = idLine.slice(3).replace(/^ /, '');
              if (!id.includes('\u0000')) lastEventId = id;
            }
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
      if (opts?.maxAttempts !== undefined && attempt > opts.maxAttempts) {
        // Consecutive failures exhausted — stop and let the consumer reconcile
        // against its durable state rather than spinning forever.
        opts.onExhausted?.();
        return;
      }
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
