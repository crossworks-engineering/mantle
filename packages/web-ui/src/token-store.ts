/**
 * Browser-side store for the owner's web bearer (kind-'m' token from
 * POST /api/auth/token). localStorage rather than an httpOnly cookie by
 * design: the zero-secret client Next server must never proxy or hold auth —
 * enforcement lives entirely in the server origin's 401s. XSS posture rests
 * on sanitized-HTML rendering, opaque-origin mini-app sandboxes, per-device
 * revocation + rotation, and the client app's CSP.
 *
 * The presence cookie is a non-httpOnly UX signal ONLY — it lets the client's
 * middleware server-redirect logged-out page loads to /login without a
 * flash. It authenticates nothing.
 *
 * Key names are contract with e2e/lib/contract.ts — the split suite seeds
 * them directly.
 */
const TOKEN_STORAGE_KEY = 'mantle_token';
const PRESENCE_COOKIE = 'mantle_authed';

function canStore(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export const tokenStore = {
  get(): string | null {
    if (!canStore()) return null;
    try {
      return window.localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    if (!canStore()) return;
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${PRESENCE_COOKIE}=1; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
    } catch {
      /* storage unavailable (private mode etc.) — the session just won't persist */
    }
  },
  clear(): void {
    if (!canStore()) return;
    try {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      document.cookie = `${PRESENCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    } catch {
      /* ignore */
    }
  },
};
