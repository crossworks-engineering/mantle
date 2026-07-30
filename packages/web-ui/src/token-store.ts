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
import './desktop-shell'; // global Window.mantleDesktop declaration

const TOKEN_STORAGE_KEY = 'mantle_token';
const PRESENCE_COOKIE = 'mantle_authed';

function canStore(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Inside Mantle Desktop the bearer lives in the shell's OS-keychain-backed
 *  vault (safeStorage) instead of localStorage — same at-rest posture as the
 *  mobile companion's Keychain. Feature-detected; browsers get localStorage
 *  exactly as before. */
function vault() {
  return typeof window !== 'undefined' ? (window.mantleDesktop?.tokenVault ?? null) : null;
}

function setPresenceCookie(): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${PRESENCE_COOKIE}=1; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
}

export const tokenStore = {
  get(): string | null {
    if (!canStore()) return null;
    try {
      const v = vault();
      if (v) {
        let token = v.get();
        if (!token) {
          // One-time migration: a pre-vault shell session left the bearer in
          // localStorage — move it into the vault and scrub the plaintext.
          token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
          if (token) {
            v.set(token);
            window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          }
        }
        return token;
      }
      return window.localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    if (!canStore()) return;
    try {
      const v = vault();
      if (v) {
        v.set(token);
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      } else {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
      setPresenceCookie();
    } catch {
      /* storage unavailable (private mode etc.) — the session just won't persist */
    }
  },
  clear(): void {
    if (!canStore()) return;
    try {
      vault()?.clear();
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      document.cookie = `${PRESENCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    } catch {
      /* ignore */
    }
  },
  /** Set ONLY the presence cookie — the same-origin cookie-login path has no
   *  bearer to store but the client middleware still keys off presence. */
  markPresence(): void {
    if (typeof document === 'undefined') return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${PRESENCE_COOKIE}=1; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`;
  },
};
