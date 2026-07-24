/**
 * The split-topology client contract. The client app (client/web, Phase 4)
 * MUST implement these names — the split e2e project injects/reads them.
 *
 * - TOKEN_STORAGE_KEY: localStorage key holding the owner bearer
 *   (client/web/lib/token-store.ts is the implementation).
 * - PRESENCE_COOKIE: non-httpOnly cookie on the CLIENT origin whose only job
 *   is letting the zero-secret client middleware redirect logged-out page
 *   loads to /login without a flash. UX, not security.
 */
export const TOKEN_STORAGE_KEY = 'mantle_token';
export const PRESENCE_COOKIE = 'mantle_authed';
