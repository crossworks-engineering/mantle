/**
 * Auth — the façade the app imports (`@/lib/auth`).
 *
 * Split along the line the code already drew for itself: what needs a database
 * and a request, and what does not.
 *
 *   ./auth/tokens   mint + verify signed credential values. Pure node:crypto
 *                   over a string; safe to import anywhere, including tests and
 *                   callers that must not pull in a Postgres client.
 *   ./auth/session  resolve WHO is calling — cookies, headers, `auth.users`,
 *                   the 401/redirect gates, password hashing.
 *   ./auth/request  read a credential off a raw Request (bearer, cookies).
 *
 * Everything stays reachable from this one module, so the ~265 existing
 * importers are unaffected by the split.
 */
export * from './auth/tokens';
export * from './auth/session';
export * from './auth/request';
