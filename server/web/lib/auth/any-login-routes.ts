/**
 * Routes every login reaches, whatever its role: about the login itself,
 * never brain data. Each entry is `METHOD pattern`, the pattern exactly as
 * the route manifest writes it. The role sweeps (member-sweep.test.ts,
 * role-sweep.test.ts) let a member and a client through these and refuse
 * them everywhere else outside their own lists. Keep it short.
 */
export const ANY_LOGIN_ROUTES: readonly string[] = [
  // Public API v1: who the credential (or API key) acts as.
  'GET /api/v1/whoami',
  // Inbound API keys: each login makes, lists and revokes its own keys
  // (an admin also sees and revokes every key). Proved per role in
  // lib/access-keys.db.test.ts.
  'GET /api/access-keys',
  'POST /api/access-keys',
  'DELETE /api/access-keys/:id',
];

export function isAnyLoginRoute(method: string, pattern: string): boolean {
  return ANY_LOGIN_ROUTES.includes(`${method.toUpperCase()} ${pattern}`);
}
