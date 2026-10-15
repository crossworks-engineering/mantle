/**
 * Cache-Control, from one place (A10 #15). Routes set the header by hand in
 * about fifty files, in a dozen spellings, and most /api answers set none
 * at all. Now:
 *
 *  - every /api answer that names no Cache-Control answers `no-store`: the
 *    gate's default (apiCacheDefault, server/middleware/gate.ts), so a
 *    route that must not be cached says nothing;
 *  - a route that may be cached, or another surface (/s, /.well-known, a
 *    page, a static asset), names its policy from CACHE_CONTROL below, never
 *    a literal.
 *
 * eslint-rules/std-helpers.mjs counts a literal Cache-Control value outside
 * this file (pinned at 0) and the files that set the header (pinned, down
 * only).
 */
export const CACHE_CONTROL = {
  /** Never stored: the /api default, a refusal, a secret's answer. */
  none: 'no-store',
  /** A server-sent event stream: never stored, never transformed by a proxy. */
  stream: 'no-store, no-transform',
  /** The health probe, for old proxies that read the older directives. */
  noneRevalidate: 'no-store, no-cache, must-revalidate',
  /** A revealed secret: every directive that says never keep it. */
  secret: 'no-store, no-cache, must-revalidate, private',
  /** A login's own bytes (a file, a frame document): never stored. */
  privateNone: 'private, no-store',
  /** Kept by the browser only, revalidated on every use (its etag). */
  privateRevalidate: 'private, no-cache',
  /** Revalidated on every use (a manifest that names the assets). */
  revalidate: 'no-cache',
  /** A login's or a link's answer kept by the browser for 30 seconds. */
  private30s: 'private, max-age=30',
  /** Public and short (the appearance a sign-in page reads). */
  public30s: 'public, max-age=30',
  /** A login's or a link's asset kept by the browser for 5 minutes. */
  private5m: 'private, max-age=300',
  /** Content-addressed: the URL changes when the bytes do. */
  publicImmutable: 'public, max-age=31536000, immutable',
  /** Content-addressed and the login's own. */
  privateImmutable: 'private, max-age=31536000, immutable',
} as const;

export type CachePolicy = keyof typeof CACHE_CONTROL;

/** The header the gate puts on an /api answer that names none. */
export const API_CACHE_DEFAULT = CACHE_CONTROL.none;

/** `{ 'Cache-Control': value }` for a response's headers. */
export function cacheHeaders(policy: CachePolicy): { 'Cache-Control': string } {
  return { 'Cache-Control': CACHE_CONTROL[policy] };
}
