import { apiUrl, withAuth } from './api-fetch';
import { tokenStore } from './token-store';

/**
 * Sign out across BOTH transports. Same-origin: POST /api/auth/logout clears
 * the session cookie, exactly as before. If a web bearer is held (the split
 * client), also revoke its device row (mobile-logout self-authenticates from
 * the bearer, idempotent) and clear the local store + presence cookie.
 * Callers navigate to /login themselves afterwards.
 */
export async function performSignOut(): Promise<void> {
  const hadToken = tokenStore.get() !== null;
  try {
    if (hadToken) {
      await fetch(apiUrl('/api/auth/mobile-logout'), withAuth({ method: 'POST' }));
    }
    await fetch(apiUrl('/api/auth/logout'), withAuth({ method: 'POST' }));
  } catch {
    /* network failure — still clear local state so the UI signs out */
  }
  tokenStore.clear();
}
