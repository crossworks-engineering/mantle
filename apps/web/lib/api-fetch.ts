/**
 * Client-side fetch helper for the `/api/**` surface — the browser counterpart
 * to the server `remote-data` seam (Phase 2 · Task 4).
 *
 * Same-origin by default: relative URL + cookie auth, exactly as today. When
 * `NEXT_PUBLIC_MANTLE_API_BASE` is set (Electron, or a detached/DB-less browser
 * client) it targets that origin and attaches the `NEXT_PUBLIC_MANTLE_API_TOKEN`
 * bearer — since cross-origin requests can't rely on the session cookie.
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
