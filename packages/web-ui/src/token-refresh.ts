import { apiUrl, withAuth } from './api-fetch';
import { tokenStore } from './token-store';

/** Days-left threshold under which the shell rotates the bearer. */
const REFRESH_UNDER_SECONDS = 7 * 24 * 60 * 60;

/** Decode the bearer's payload exp (no verification — the SERVER verifies;
 *  this only decides when to ask for a rotation). */
function tokenExpEpoch(token: string): number | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  try {
    const payload = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(atob(payload)) as { exp?: number };
    return typeof data.exp === 'number' ? data.exp : null;
  } catch {
    return null;
  }
}

/**
 * Opportunistic bearer rotation — called from the app shell's boot path (it
 * already round-trips /api/shell). No-op unless a stored web bearer exists
 * AND expires within 7 days: an active browser therefore never expires; an
 * idle one dies at the 30-day TTL. Failures are swallowed — the current
 * token keeps working until its real expiry, and the next boot retries.
 */
export async function maybeRefreshToken(): Promise<void> {
  const token = tokenStore.get();
  if (!token) return;
  const exp = tokenExpEpoch(token);
  if (exp === null) return;
  if (exp - Date.now() / 1000 > REFRESH_UNDER_SECONDS) return;
  try {
    const res = await fetch(apiUrl('/api/auth/token/refresh'), withAuth({ method: 'POST' }));
    if (!res.ok) return;
    const body = (await res.json()) as { token?: string };
    if (body.token) tokenStore.set(body.token);
  } catch {
    /* network hiccup — retry on next shell boot */
  }
}
