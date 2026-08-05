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
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { bearerFrom } from './auth/request';
import {
  db,
  oauthAccessTokens,
  oauthAuthCodes,
  oauthClients,
  resolveSingleOwnerId,
  type OAuthClient,
} from '@mantle/db';
import { loadProfilePreferences, publicBaseUrl } from '@mantle/content';

export const ACCESS_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
export const CODE_TTL_SEC = 60 * 5; // 5 minutes
/** How long a refresh token stays usable AFTER it has been used once. Several
 *  clients legitimately share one grant (claude.ai fans a connector out to many
 *  agents/sessions), so concurrent refreshes must not brick the losers — see
 *  refreshAccessToken. Standard rotation leeway, same idea as Auth0's. */
export const REFRESH_GRACE_SEC = 120;
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

/** The connector URL the owner pastes into claude.ai. Same as the resource URL. */
export function connectorUrl(): string {
  return mcpResourceUrl();
}

/** Whether THIS box exposes its remote MCP connector (per the sole owner's
 *  preference; default OFF). The connector endpoints gate on this so the whole
 *  surface is invisible (404) until the owner opts in from Settings → MCP.
 *  Single-owner by design — Mantle is one brain per box. */
export async function isRemoteMcpEnabled(): Promise<boolean> {
  const ownerId = await resolveSingleOwnerId();
  if (!ownerId) return false;
  const prefs = await loadProfilePreferences(ownerId);
  return prefs.remoteMcpEnabled === true;
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

async function issueTokens(
  clientId: string,
  ownerId: string,
  scope: string,
): Promise<TokenResponse> {
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

/** refresh_token grant — concurrency-safe rotation.
 *
 *  More than one client can legitimately hold the same grant at once (claude.ai
 *  fans one connector out to many agents and sessions), so a refresh must never
 *  kill a sibling's credentials. The pre-v0.218 in-place rotation did exactly
 *  that: the first refresh instantly invalidated both tokens, and the second
 *  refresher got invalid_grant — a dead connector until manual re-auth.
 *
 *  Instead, each refresh FORKS the grant:
 *  - a brand-new token row is minted for the caller;
 *  - the old ACCESS token lives out its natural TTL (bearer-until-expiry is the
 *    normal contract; instant revocation on rotation was overkill);
 *  - the presented REFRESH token stays usable for REFRESH_GRACE_SEC after this
 *    first use, so a concurrent refresher forks its own row instead of dying.
 *    After the grace window it is dead for good. The window trades a sliver of
 *    stolen-token replay detection for not bricking honest concurrent clients.
 *  - rows that can never authenticate again (access AND refresh both expired)
 *    are swept opportunistically, so forking doesn't accumulate rows.
 *
 *  Rejections log the client id: on the client side invalid_grant kills the
 *  connector silently, so the server must at least say it happened. */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
}): Promise<GrantResult> {
  const fail = (why: string): GrantResult => {
    console.warn(`[mcp-oauth] refresh rejected (${why}) client=${input.clientId}`);
    return { ok: false, error: 'invalid_grant' };
  };
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
  if (!row) return fail('unknown or rotated-out refresh token');
  if (row.clientId !== input.clientId) return fail('client mismatch');
  if (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() < Date.now()) {
    return fail('refresh token expired');
  }

  const tokens = await issueTokens(row.clientId, row.ownerId, row.scope);

  // Shorten (never extend) the presented refresh token's remaining life to the
  // grace window, and stamp the use. The old access token is left untouched.
  const now = Date.now();
  const graceEnd = new Date(now + REFRESH_GRACE_SEC * 1000);
  await db
    .update(oauthAccessTokens)
    .set({
      refreshExpiresAt:
        row.refreshExpiresAt.getTime() > graceEnd.getTime() ? graceEnd : row.refreshExpiresAt,
      lastUsedAt: new Date(now),
    })
    .where(eq(oauthAccessTokens.id, row.id));

  // Sweep this client's fully-dead rows (both tokens past expiry). Best-effort:
  // a failed sweep must not fail the grant.
  try {
    await db
      .delete(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.clientId, row.clientId),
          lt(oauthAccessTokens.expiresAt, new Date(now)),
          lt(oauthAccessTokens.refreshExpiresAt, new Date(now)),
        ),
      );
  } catch {
    // swept next time
  }

  return { ok: true, tokens };
}

// ── Bearer validation (resource server) ──────────────────────────────────────

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
