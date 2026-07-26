/**
 * Runtime client configuration — the escape hatch from build-time-inlined
 * `NEXT_PUBLIC_*` vars, so ONE prebuilt client image can point at any server.
 *
 * The client app serves `/env.js` (a force-dynamic route reading process.env
 * per request) as a blocking script in its root layout head; it sets
 * `window.__MANTLE_ENV__` before any bundle code runs. Everything here falls
 * back to the build-time var, so:
 *   - same-origin monolith: both empty → today's behavior, untouched
 *   - detached dev (dev:fe): build-time vars, exactly as before
 *   - split client image: runtime values win
 */
export type MantleRuntimeEnv = {
  /** API/backend origin (the server app). Empty = same-origin. */
  apiBase?: string;
  /** Canonical server origin for links that must point at the server app. */
  serverOrigin?: string;
  /** Live turn-streaming flag (mirrors NEXT_PUBLIC_MANTLE_TURN_STREAMING). */
  turnStreaming?: string;
};

declare global {
  interface Window {
    __MANTLE_ENV__?: MantleRuntimeEnv;
  }
}

export function runtimeEnv(): MantleRuntimeEnv {
  if (typeof window === 'undefined') return {};
  return window.__MANTLE_ENV__ ?? {};
}

/** The API base origin, trailing-slash-stripped. Empty string = same-origin. */
export function runtimeApiBase(): string {
  const v = runtimeEnv().apiBase ?? process.env.NEXT_PUBLIC_MANTLE_API_BASE ?? '';
  return v.replace(/\/+$/, '');
}

/**
 * Is the API actually on a DIFFERENT origin than the page?
 *
 * NOT the same question as `runtimeApiBase() !== ''`. Since the v0.200 split
 * the client app always needs an absolute MANTLE_SERVER_ORIGIN (its own
 * server-side fetches can't be relative), so on the DEFAULT deployment shape —
 * one domain, path-routed (install.sh + Caddyfile.same-origin) — apiBase is
 * set AND equals the page origin. Treating "set" as "cross-origin" disabled
 * same-origin behavior (cookies, the inline share reader) on every production
 * box. Compare real origins instead.
 *
 * SSR returns false: the client app's server pass has no page origin to
 * compare against, and every consumer of this flag renders behind a client
 * fetch or runs in an event handler, so the browser value is the one that
 * ever matters.
 */
export function isCrossOrigin(): boolean {
  const base = runtimeApiBase();
  if (!base || typeof window === 'undefined') return false;
  try {
    return new URL(base, window.location.href).origin !== window.location.origin;
  } catch {
    // Unparseable base: treat as same-origin — relative fetches still work.
    return false;
  }
}

/**
 * Absolute URL for a path the SERVER app serves, not the client one.
 *
 * `/s/…` share links are the case that matters. Since the member carve the
 * owner UI and the server are two different origins, and a link built from
 * `window.location.origin` points at the client — which does not serve `/s` at
 * all, so every link an owner copied 404'd (or bounced to /login). Falls back
 * to the current origin, which is correct for the same-origin monolith.
 */
export function serverUrl(path: string): string {
  const base = (runtimeEnv().serverOrigin ?? runtimeApiBase()).replace(/\/+$/, '');
  if (base) return `${base}${path}`;
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}
