import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * OAuth 2.1 authorization-server state for the remote MCP connector.
 *
 * Mantle is the AS for its own `/api/mcp` resource: a claude.ai custom
 * connector registers (Dynamic Client Registration, RFC 7591), the owner signs
 * in + consents (authorize), and the client exchanges a PKCE-protected code for
 * an access token (token). All three tables below back that flow. See the plan
 * (~/.claude/plans/sharded-honking-wilkinson.md) and apps/web/lib/mcp-oauth.ts.
 *
 * Secrets at rest: authorization codes and access/refresh tokens are stored ONLY
 * as their SHA-256 hash (same treatment as inbound peer tokens, see
 * packages/content/src/peers-crypto.ts) — the plaintext is handed to the client
 * once and never persisted. Clients are PUBLIC (PKCE, no client secret), so
 * oauth_clients holds no secret to hash.
 *
 * The `owner_id` FKs into `auth.users` are declared in the SQL migration, not
 * here — Drizzle only manages public.* (see schema/auth-users.ts).
 */

/**
 * A registered OAuth client (one per connector install). Public client: no
 * secret, authenticates the token exchange with PKCE alone. Created by the
 * Dynamic Client Registration endpoint from the redirect URIs claude.ai sends.
 */
export const oauthClients = pgTable('oauth_clients', {
  /** The `client_id` returned to the client. */
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /** `client_name` from the registration request (e.g. "Claude"). */
  clientName: text('client_name'),
  /** Exact redirect URIs the client registered; the authorize/token endpoints
   *  only ever redirect to one of these (exact match). */
  redirectUris: text('redirect_uris').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A single-use authorization code, minted at consent and burned at token
 * exchange. Short-lived (5 min). Stored hashed; the row is DELETED on a
 * successful exchange so a code can never be replayed.
 */
export const oauthAuthCodes = pgTable(
  'oauth_auth_codes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** SHA-256 of the code handed to the client. */
    codeHash: text('code_hash').notNull().unique(),
    clientId: uuid('client_id').notNull(),
    /** The consenting owner (auth.users.id) the eventual token is scoped to. */
    ownerId: uuid('owner_id').notNull(),
    /** PKCE S256 challenge; verified against the verifier at token exchange. */
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
    /** Must exactly match the redirect_uri presented at the token endpoint. */
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope').notNull().default(''),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('oauth_auth_codes_client_idx').on(t.clientId)],
);

/**
 * An issued access token (and its optional refresh token), scoped to one owner
 * + client. Both are stored hashed. The access token is short-lived (1 h); the
 * refresh token (if issued) is long-lived and rotated in place on each refresh.
 * `revoked_at` kills both at once — that's the "Disconnect" in Settings.
 */
export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** SHA-256 of the bearer access token. */
    tokenHash: text('token_hash').notNull().unique(),
    /** SHA-256 of the refresh token, rotated on each use; null if none issued. */
    refreshTokenHash: text('refresh_token_hash').unique(),
    ownerId: uuid('owner_id').notNull(),
    clientId: uuid('client_id').notNull(),
    scope: text('scope').notNull().default(''),
    /** Access-token expiry (≈1 h). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Refresh-token expiry (≈30 d); null if no refresh token. */
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Set on Disconnect / revoke; null while active. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('oauth_access_tokens_owner_idx').on(t.ownerId),
    index('oauth_access_tokens_client_idx').on(t.clientId),
  ],
);

export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
export type OAuthAuthCode = typeof oauthAuthCodes.$inferSelect;
export type NewOAuthAuthCode = typeof oauthAuthCodes.$inferInsert;
export type OAuthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type NewOAuthAccessToken = typeof oauthAccessTokens.$inferInsert;
