/**
 * Remote-data seam — the switch that makes DB-less local dev possible.
 *
 * Normally `apps/web` reads the database in-process (RSC + server actions call
 * `@mantle/*` package functions directly). That couples even "just the UI" to a
 * Postgres connection. When `MANTLE_REMOTE_API` is set, server-side data access
 * instead fetches a *deployed* Mantle's HTTP API with a bearer token — so a
 * developer can run the frontend with **no Postgres credentials at all**.
 *
 * This is opt-in and inert by default: with `MANTLE_REMOTE_API` unset,
 * `isRemoteData()` is false and every call path stays exactly as it was. Pages
 * adopt it through a small `lib/data/*` module that branches on `isRemoteData()`
 * — local package fn vs `remoteGet()`. See docs/db-less-dev.md.
 *
 * Server-only (uses a server-held token). Never import from a client component.
 */
import 'server-only';

/** The remote API base URL (no trailing slash), or null when running normally. */
export function remoteApiBase(): string | null {
  const raw = process.env.MANTLE_REMOTE_API?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/** True when the frontend is sourcing data from a remote API (DB-less dev). */
export function isRemoteData(): boolean {
  return remoteApiBase() !== null;
}

/**
 * GET a JSON resource from the remote Mantle API with the dev bearer token.
 * Throws if remote mode isn't configured or the response isn't ok — callers run
 * inside RSC/actions where a thrown error surfaces as the normal error path.
 */
export async function remoteGet<T>(path: string): Promise<T> {
  const base = remoteApiBase();
  if (!base) throw new Error('remoteGet called without MANTLE_REMOTE_API set');
  const token = process.env.MANTLE_API_TOKEN?.trim();
  if (!token) throw new Error('MANTLE_API_TOKEN must be set for DB-less (remote) dev');
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    // Dev data should never be statically cached — always reflect the remote.
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`remote GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
