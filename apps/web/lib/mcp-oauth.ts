/**
 * OAuth 2.1 authorization-server logic for the remote MCP connector.
 *
 * Mantle is the AS for its own `/api/mcp` resource. This module is the trust
 * core shared by the OAuth route handlers (register / authorize / token) and the
 * `/api/mcp` bearer check. It deals only in HASHED secrets: codes and tokens are
 * generated here, the plaintext is returned to the caller once, and only the
 * SHA-256 is persisted (mirrors inbound peer-token handling).
 *
 * Pitfall checklist baked in (per the plan): PKCE S256 only, single-use codes
 * (deleted on exchange), 5-min code TTL, exact redirect_uri match, hashed at
 * rest, constant-time comparisons. HTTPS enforcement lives in the route layer.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  db,
  oauthAccessTokens,
  oauthAuthCodes,
  oauthClients,
  type OAuthClient,
} from '@mantle/db';
import { publicBaseUrl } from '@mantle/content';

export const ACCESS_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
export const CODE_TTL_SEC = 60 * 5; // 5 minutes
/** Single default scope for now (full surface). A read-only scope is a deferred
 *  knob in the plan; the /api/mcp surface doesn't branch on it yet. */
export const DEFAULT_SCOPE = 'mcp';

const ACCESS_PREFIX = 'mtlmcp_at_';
const REFRESH_PREFIX = 'mtlmcp_rt_';
const CODE_PREFIX = 'mtlmcp_ac_';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function randomToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── Discovery URLs (RFC 8414 / 9728) ─────────────────────────────────────────

export function issuerUrl(): string {
  return publicBaseUrl();
}
export function mcpResourceUrl(): string {
  return `${publicBaseUrl()}/api/mcp`;
}
export function protectedResourceMetadataUrl(): string {
  return `${publicBaseUrl()}/.well-known/oauth-protected-resource`;
}
/** The `WWW-Authenticate` value a 401 from the resource returns, pointing the
 *  client at the protected-resource metadata so it can discover the AS. */
export function wwwAuthenticateHeader(): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

/** Verify an RFC 7636 S256 challenge: base64url(SHA-256(verifier)) == challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return constantTimeEqual(computed, challenge);
}

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────

/** A redirect URI is acceptable if it's https, or http on loopback (dev /
 *  native-app localhost callbacks). Everything else is rejected. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
    return true;
  }
  return false;
}

export async function registerClient(input: {
  clientName?: string | null;
  redirectUris: string[];
}): Promise<OAuthClient> {
  const [row] = await db
    .insert(oauthClients)
    .values({
      clientName: input.clientName ?? null,
      redirectUris: input.redirectUris,
    })
    .returning();
  return row!;
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  return row ?? null;
}

// ── Authorization codes ──────────────────────────────────────────────────────

/** Mint a single-use authorization code (5-min TTL). Returns the plaintext code
 *  to redirect back to the client; only its hash is stored. */
export async function mintAuthCode(input: {
  clientId: string;
  ownerId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  scope: string;
}): Promise<string> {
  const code = randomToken(CODE_PREFIX);
  await db.insert(oauthAuthCodes).values({
    codeHash: sha256Hex(code),
    clientId: input.clientId,
    ownerId: input.ownerId,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    redirectUri: input.redirectUri,
    scope: input.scope,
    expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
  });
  return code;
}

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
};

type GrantResult = { ok: true; tokens: TokenResponse } | { ok: false; error: string };

async function issueTokens(clientId: string, ownerId: string, scope: string): Promise<TokenResponse> {
  const accessToken = randomToken(ACCESS_PREFIX);
  const refreshToken = randomToken(REFRESH_PREFIX);
  const now = Date.now();
  await db.insert(oauthAccessTokens).values({
    tokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    ownerId,
    clientId,
    scope,
    expiresAt: new Date(now + ACCESS_TTL_SEC * 1000),
    refreshExpiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
  });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    scope,
  };
}

/** authorization_code grant: validate the code (TTL, client, exact redirect_uri,
 *  PKCE), burn it (single-use), and issue tokens. */
export async function exchangeAuthCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GrantResult> {
  const [row] = await db
    .select()
    .from(oauthAuthCodes)
    .where(eq(oauthAuthCodes.codeHash, sha256Hex(input.code)))
    .limit(1);
  if (!row) return { ok: false, error: 'invalid_grant' };

  // Single-use: burn the code immediately, before any further branching, so it
  // can never be replayed regardless of the validation outcome below.
  await db.delete(oauthAuthCodes).where(eq(oauthAuthCodes.id, row.id));

  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: 'invalid_grant' };
  if (row.clientId !== input.clientId) return { ok: false, error: 'invalid_grant' };
  if (row.redirectUri !== input.redirectUri) return { ok: false, error: 'invalid_grant' };
  if (row.codeChallengeMethod !== 'S256') return { ok: false, error: 'invalid_grant' };
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    return { ok: false, error: 'invalid_grant' };
  }

  const tokens = await issueTokens(row.clientId, row.ownerId, row.scope);
  return { ok: true, tokens };
}

/** refresh_token grant: validate the refresh token (not revoked, not expired,
 *  client match) and rotate BOTH tokens in place on the same row. */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
}): Promise<GrantResult> {
  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.refreshTokenHash, sha256Hex(input.refreshToken)),
        isNull(oauthAccessTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, error: 'invalid_grant' };
  if (row.clientId !== input.clientId) return { ok: false, error: 'invalid_grant' };
  if (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'invalid_grant' };
  }

  const accessToken = randomToken(ACCESS_PREFIX);
  const refreshToken = randomToken(REFRESH_PREFIX);
  const now = Date.now();
  await db
    .update(oauthAccessTokens)
    .set({
      tokenHash: sha256Hex(accessToken),
      refreshTokenHash: sha256Hex(refreshToken),
      expiresAt: new Date(now + ACCESS_TTL_SEC * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
      lastUsedAt: new Date(now),
    })
    .where(eq(oauthAccessTokens.id, row.id));

  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      scope: row.scope,
    },
  };
}

// ── Bearer validation (resource server) ──────────────────────────────────────

function bearerFrom(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

/** Resolve the owner for a valid, unexpired, unrevoked access token, or null.
 *  Touches `last_used_at` best-effort for the Settings "connected clients" view. */
export async function ownerFromBearer(req: Request): Promise<string | null> {
  const token = bearerFrom(req);
  if (!token) return null;
  const [row] = await db
    .select({ id: oauthAccessTokens.id, ownerId: oauthAccessTokens.ownerId })
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, sha256Hex(token)),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  void db
    .update(oauthAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthAccessTokens.id, row.id))
    .catch(() => {});
  return row.ownerId;
}
