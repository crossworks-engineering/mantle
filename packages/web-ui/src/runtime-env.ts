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
