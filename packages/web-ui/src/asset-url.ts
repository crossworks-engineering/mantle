/**
 * Client-side resolver for browser-native asset sources — the `<img>`/`<iframe>`/
 * download `src`s pointing at `/api/files/files/[id]?raw=1` and
 * `/api/attachments/[id]`. Those loaders can't send the `Authorization` header
 * that `apiFetch` uses, so in a detached/Electron client (cross-origin, no
 * session cookie) they'd 401.
 *
 * Same-origin (the normal case): returns the path unchanged — the session cookie
 * authenticates, exactly as before. Detached (`NEXT_PUBLIC_MANTLE_API_BASE` set):
 * targets the remote origin and appends the short-lived `?at=` asset token minted
 * by `GET /api/shell` (see `buildAssetToken`/`getOwnerForAsset` in lib/auth and
 * the asset-path acceptance in middleware.ts).
 */

import { runtimeApiBase } from './runtime-env';

/** Resolved at call time (runtime config first) — see api-fetch.ts. */
function apiBaseValue(): string {
  return runtimeApiBase();
}

let assetToken: string | null = null;

/** Set by `AppShell` from the `GET /api/shell` response. Only used in detached
 *  mode; harmless to set same-origin (where `assetUrl` ignores it). */
export function setAssetToken(token: string | null | undefined): void {
  assetToken = token ?? null;
}

/** Resolve a raw-asset path to a loadable URL (see module comment). */
export function assetUrl(path: string): string {
  if (!apiBaseValue()) return path; // same-origin — cookie auth, path unchanged
  const base = `${apiBaseValue()}${path}`;
  if (!assetToken) return base; // token not loaded yet — will 401 until shell resolves
  return `${base}${path.includes('?') ? '&' : '?'}at=${encodeURIComponent(assetToken)}`;
}
