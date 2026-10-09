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
import { lockOauthActor, type OauthExec as Exec } from './oauth-lock';
import { bearerFrom } from './auth/request';
import {
  authUsers,
  db,
  mcpLoginAccess,
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

/** Client ids are uuids (the registry's primary key). Anything else is an
 *  unknown client, answered before the query: Postgres would refuse a
 *  non-uuid with 22P02, which surfaced as a 500 (F31). */
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!CLIENT_ID_RE.test(clientId)) return null;
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  return row ?? null;
}

// ── Authorization codes ──────────────────────────────────────────────────────

/** Mint a single-use authorization code (5-min TTL). Returns the plaintext code
 *  to redirect back to the client; only its hash is stored. */
export async function mintAuthCode(input: {
  clientId: string;
  ownerId: string;
  /** The consenting login (`SessionUser.actor.id`), not the anchor. */
  actorId: string;
  /** A member's or client's session epoch at consent (0227); null for an
   *  admin. The grant dies when the login's epoch moves on. */
  sessionEpoch?: number | null;
  /** The login's session epoch when its session was checked for this
   *  consent (any role). The code is minted only if it still is: a session
   *  ended meanwhile (verification audit N2) mints nothing. */
  consentEpoch: number;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  scope: string;
}): Promise<string | null> {
  const code = randomToken(CODE_PREFIX);
  // Under the login's OAuth lock, the one endLoginSessions takes before it
  // deletes codes: a code minted here is either deleted by it or refused.
  return db.transaction(async (tx) => {
    await lockOauthActor(tx, input.actorId);
    const [login] = await tx
      .select({ epoch: authUsers.sessionEpoch })
      .from(authUsers)
      .where(eq(authUsers.id, input.actorId))
      .limit(1);
    if (!login || login.epoch !== input.consentEpoch) return null;
    await mintCodeRow(tx, code, input);
    return code;
  });
}

async function mintCodeRow(
  tx: Exec,
  code: string,
  input: {
    clientId: string;
    ownerId: string;
    actorId: string;
    sessionEpoch?: number | null;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    scope: string;
  },
): Promise<void> {
  await tx.insert(oauthAuthCodes).values({
    codeHash: sha256Hex(code),
    clientId: input.clientId,
    ownerId: input.ownerId,
    actorId: input.actorId,
    sessionEpoch: input.sessionEpoch ?? null,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    redirectUri: input.redirectUri,
    scope: input.scope,
    expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
  });
}

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
};

/** A grant that was made names its login and client, for the token route's
 *  audit row (access matrix T11). */
type GrantResult =
  | { ok: true; tokens: TokenResponse; login: { id: string; email: string }; clientId: string }
  | { ok: false; error: string };

/**
 * May this login hold (or keep using) a connector grant? Read from the row on
 * every use, never from the token, like the session and bearer paths. A
 * disabled or deleted login may not: a grant lives only as long as the login
 * that made it.
 *
 *  - An ADMIN grant (no epoch on it): the login is still an admin.
 *  - A MEMBER's or CLIENT's grant (0227, MCP as a login): the login still has
 *    that kind of role, its session epoch is the one the grant was made
 *    under (sign out everywhere, a password change, a disable or a role
 *    change ends it), and an admin still has its MCP switch on.
 */
export async function actorMayConnect(
  actorId: string,
  sessionEpoch: number | null,
  /** Under the OAuth lock: the transaction, never a second connection
   *  (verification audit N1). */
  exec: Exec = db,
): Promise<boolean> {
  return (await connectingLogin(actorId, sessionEpoch, exec)) !== null;
}

/** actorMayConnect, answering the login's email (the audit row's) when it
 *  may connect, else null. */
async function connectingLogin(
  actorId: string,
  sessionEpoch: number | null,
  exec: Exec,
): Promise<{ id: string; email: string } | null> {
  const [row] = await exec
    .select({
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
      email: authUsers.email,
      sessionEpoch: authUsers.sessionEpoch,
      mcpEnabled: mcpLoginAccess.enabled,
    })
    .from(authUsers)
    .leftJoin(mcpLoginAccess, eq(mcpLoginAccess.loginId, authUsers.id))
    .where(eq(authUsers.id, actorId))
    .limit(1);
  if (!row || row.disabledAt || !row.email) return null;
  const may =
    sessionEpoch === null
      ? row.role === 'admin'
      : (row.role === 'member' || row.role === 'client') &&
        row.sessionEpoch === sessionEpoch &&
        row.mcpEnabled === true;
  return may ? { id: actorId, email: row.email } : null;
}

async function issueTokens(
  clientId: string,
  ownerId: string,
  actorId: string,
  scope: string,
  sessionEpoch: number | null,
  exec: Exec = db,
): Promise<TokenResponse> {
  const accessToken = randomToken(ACCESS_PREFIX);
  const refreshToken = randomToken(REFRESH_PREFIX);
  const now = Date.now();
  await exec.insert(oauthAccessTokens).values({
    tokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    ownerId,
    actorId,
    clientId,
    scope,
    sessionEpoch,
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
  const codeHash = sha256Hex(input.code);
  // The code's login first, to take its lock (final audit F3): the claim and
  // the new grant then happen inside it, so a session end (which takes the
  // same lock, deletes the codes and revokes the grants) either runs first
  // and leaves no code to claim, or runs after and revokes the new grant.
  const [peek] = await db
    .select({ actorId: oauthAuthCodes.actorId })
    .from(oauthAuthCodes)
    .where(and(eq(oauthAuthCodes.codeHash, codeHash), gt(oauthAuthCodes.expiresAt, new Date())))
    .limit(1);
  if (!peek) return { ok: false, error: 'invalid_grant' };
  return db.transaction(async (tx) => {
    await lockOauthActor(tx, peek.actorId);
    return exchangeClaimed(tx, codeHash, input);
  });
}

async function exchangeClaimed(
  tx: Exec,
  codeHash: string,
  input: { clientId: string; redirectUri: string; codeVerifier: string },
): Promise<GrantResult> {
  // Single-use: the code is claimed and burned in ONE statement, before any
  // further branching, so it can never be replayed regardless of the
  // validation outcome below. Two exchanges of one code at once: only one
  // DELETE returns the row (F31; a SELECT then DELETE let both through).
  const [row] = await tx
    .delete(oauthAuthCodes)
    .where(eq(oauthAuthCodes.codeHash, codeHash))
    .returning();
  if (!row) return { ok: false, error: 'invalid_grant' };

  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: 'invalid_grant' };
  if (row.clientId !== input.clientId) return { ok: false, error: 'invalid_grant' };
  if (row.redirectUri !== input.redirectUri) return { ok: false, error: 'invalid_grant' };
  if (row.codeChallengeMethod !== 'S256') return { ok: false, error: 'invalid_grant' };
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    return { ok: false, error: 'invalid_grant' };
  }

  // The login may have been demoted or disabled between consent and exchange.
  const login = await connectingLogin(row.actorId, row.sessionEpoch ?? null, tx);
  if (!login) return { ok: false, error: 'invalid_grant' };

  const tokens = await issueTokens(
    row.clientId,
    row.ownerId,
    row.actorId,
    row.scope,
    row.sessionEpoch ?? null,
    tx,
  );
  return { ok: true, tokens, login, clientId: row.clientId };
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
  const refreshHash = sha256Hex(input.refreshToken);
  const [peek] = await db
    .select({ actorId: oauthAccessTokens.actorId })
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.refreshTokenHash, refreshHash),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.refreshExpiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!peek) return fail('unknown or rotated-out refresh token');
  // Under the login's lock (final audit F3): a revoke that ran first is seen
  // here (the row is revoked), and one that waits for us revokes the new row.
  const result = await db.transaction(async (tx) => {
    await lockOauthActor(tx, peek.actorId);
    return refreshLocked(tx, refreshHash, input.clientId, fail);
  });
  if (!result.ok) return result;

  // Sweep this client's fully-dead rows (both tokens past expiry). Best-effort:
  // a failed sweep must not fail the grant.
  try {
    const now = new Date();
    await db
      .delete(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.clientId, input.clientId),
          lt(oauthAccessTokens.expiresAt, now),
          lt(oauthAccessTokens.refreshExpiresAt, now),
        ),
      );
  } catch {
    // swept next time
  }
  return result;
}

async function refreshLocked(
  tx: Exec,
  refreshHash: string,
  clientId: string,
  fail: (why: string) => GrantResult,
): Promise<GrantResult> {
  const [row] = await tx
    .select()
    .from(oauthAccessTokens)
    .where(
      and(eq(oauthAccessTokens.refreshTokenHash, refreshHash), isNull(oauthAccessTokens.revokedAt)),
    )
    .limit(1);
  if (!row) return fail('unknown or rotated-out refresh token');
  if (row.clientId !== clientId) return fail('client mismatch');
  if (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() < Date.now()) {
    return fail('refresh token expired');
  }
  // Refresh forks new rows, so without this a locked-out login's connector
  // would outlive every revoke that ran before the fork.
  const login = await connectingLogin(row.actorId, row.sessionEpoch ?? null, tx);
  if (!login) return fail('login may no longer connect');

  const tokens = await issueTokens(
    row.clientId,
    row.ownerId,
    row.actorId,
    row.scope,
    row.sessionEpoch ?? null,
    tx,
  );

  // Shorten (never extend) the presented refresh token's remaining life to the
  // grace window, and stamp the use. The old access token is left untouched.
  const now = Date.now();
  const graceEnd = new Date(now + REFRESH_GRACE_SEC * 1000);
  await tx
    .update(oauthAccessTokens)
    .set({
      refreshExpiresAt:
        row.refreshExpiresAt.getTime() > graceEnd.getTime() ? graceEnd : row.refreshExpiresAt,
      lastUsedAt: new Date(now),
    })
    .where(eq(oauthAccessTokens.id, row.id));
  return { ok: true, tokens, login, clientId: row.clientId };
}

// ── Bearer validation (resource server) ──────────────────────────────────────

/** Resolve the owner for a valid, unexpired, unrevoked access token, or null.
 *  The login that holds the grant must still be a usable admin (read from its
 *  row now, joined in the same query): a demoted, disabled or deleted login's
 *  connector stops on its next call.
 *  Touches `last_used_at` best-effort for the Settings "connected clients" view. */
export async function ownerFromBearer(req: Request): Promise<string | null> {
  const token = bearerFrom(req);
  if (!token) return null;
  const [row] = await db
    .select({ id: oauthAccessTokens.id, ownerId: oauthAccessTokens.ownerId })
    .from(oauthAccessTokens)
    .innerJoin(authUsers, eq(authUsers.id, oauthAccessTokens.actorId))
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, sha256Hex(token)),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
        eq(authUsers.role, 'admin'),
        isNull(authUsers.disabledAt),
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

/**
 * The grant behind an access token, for any login (0227, MCP as a login):
 * the anchor, the login and the epoch it was made under, or null for an
 * unknown, expired or revoked token. Whether the login may still use it is
 * `actorMayConnect`; server/web/lib/mcp-auth.ts runs both.
 */
export async function grantFromAccessToken(token: string): Promise<{
  id: string;
  ownerId: string;
  actorId: string;
  clientId: string;
  sessionEpoch: number | null;
} | null> {
  const [row] = await db
    .select({
      id: oauthAccessTokens.id,
      ownerId: oauthAccessTokens.ownerId,
      actorId: oauthAccessTokens.actorId,
      clientId: oauthAccessTokens.clientId,
      sessionEpoch: oauthAccessTokens.sessionEpoch,
    })
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
  return { ...row, sessionEpoch: row.sessionEpoch ?? null };
}
