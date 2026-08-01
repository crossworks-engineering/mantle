/**
 * Signed credential values — the pure half of lib/auth.
 *
 * Every credential Mantle mints has the shape `<payload>.<signature>`, where
 * payload is base64url(JSON claims, always including `exp`) and signature is
 * HMAC-SHA256 of that payload under SESSION_SECRET. Claims carry a `k` kind
 * marker so a value minted for one surface can never be replayed on another.
 * The session cookie is the single KINDLESS shape, and its verifier rejects
 * anything carrying `k` — see verifySessionCookie for why that matters.
 *
 * Nothing here touches the database, the request context or HTTP. That is what
 * lets the co-located vitest run, and any caller that must not drag a Postgres
 * client behind it, import this module directly.
 *
 * Stateless by design: there is no session table. Rotating SESSION_SECRET
 * invalidates every outstanding credential at once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE_NAME } from '../auth-constants';

/** The `k` claim: mobile bearer, asset token, team visitor, team chat. */
type TokenKind = 'm' | 'a' | 't' | 'c';

/**
 * Claims whose signature, kind and expiry have already been checked. Every
 * field beyond `exp` is still untrusted in SHAPE — each verifier narrows the
 * claims it cares about before handing them to a caller.
 */
type SignedClaims = Record<string, unknown> & { exp: number };

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function secret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET must be set (>=32 chars). Run `openssl rand -base64 48`.');
  }
  return Buffer.from(s);
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/**
 * Mint a signed value: `claims` plus an `exp` of `ttlSeconds` from now, encoded
 * and signed. Returns the value and the absolute expiry, since several callers
 * report the latter back to a client.
 */
function signClaims(
  claims: Record<string, unknown>,
  ttlSeconds: number,
): { value: string; exp: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64urlEncode(Buffer.from(JSON.stringify({ ...claims, exp }), 'utf8'));
  const sig = createHmac('sha256', secret()).update(payload).digest();
  return { value: `${payload}.${b64urlEncode(sig)}`, exp };
}

/**
 * The verification spine every credential below shares: constant-time signature
 * check, kind check, expiry check. Returns the decoded claims, or null if the
 * value is malformed, forged, of the wrong kind, or expired.
 *
 * `kind` is null for the session cookie only — the kindless shape. Keeping the
 * two cases explicit (rather than collapsing them) is deliberate: `k: null` in
 * a payload must NOT satisfy the session check, and an exact comparison is the
 * only form where that reads unambiguously.
 */
function verifySigned(value: string, kind: TokenKind | null): SignedClaims | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const got = b64urlDecode(value.slice(dot + 1));
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;

  try {
    const data: unknown = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const claims = data as Record<string, unknown>;

    if (kind === null) {
      if (claims.k !== undefined) return null;
    } else if (claims.k !== kind) {
      return null;
    }

    const exp = claims.exp;
    if (typeof exp !== 'number') return null;
    if (Date.now() / 1000 > exp) return null;
    return { ...claims, exp };
  } catch {
    return null;
  }
}

// ── Session cookies (kindless) ───────────────────────────────────────────────

export { SESSION_COOKIE_NAME };

export function buildSessionCookie(
  userId: string,
  ttlSeconds: number = ONE_YEAR_SECONDS,
): { value: string; maxAgeSec: number } {
  return { value: signClaims({ uid: userId }, ttlSeconds).value, maxAgeSec: ttlSeconds };
}

/**
 * Verify a session cookie value: signature, expiry, and that it is KINDLESS.
 *
 * The kind check is the load-bearing part. Mobile (`k:'m'`) and asset (`k:'a'`)
 * tokens share the `{uid, exp}` payload, so without it a signed mobile token
 * pasted into the cookie would authenticate through this DB-lookup path — which
 * never consults mobile_tokens.revoked_at, dodging a mobile logout — and an
 * asset token would grant full session access instead of just byte-serving.
 */
export function verifySessionCookie(value: string): { uid: string; exp: number } | null {
  const claims = verifySigned(value, null);
  if (!claims || typeof claims.uid !== 'string') return null;
  return { uid: claims.uid, exp: claims.exp };
}

/**
 * Short-lived session-cookie VALUE for server-internal renders — the PDF path
 * (lib/render-pdf.ts) hands it to the browserless sidecar so /print/pages/[id]
 * and its image subresources authenticate as the owner REGARDLESS of how the
 * caller authenticated (cookie, mobile bearer, web bearer). Never sent to a
 * client; ~5 minutes bounds a leaked render URL.
 */
export function buildInternalRenderCookie(userId: string, ttlSeconds = 300): string {
  return `${SESSION_COOKIE_NAME}=${buildSessionCookie(userId, ttlSeconds).value}`;
}

// ── Mobile companion bearer tokens (`k:'m'`) ─────────────────────────────────
// Same signed format as the session cookie, but the payload carries a `jti`
// (the mobile_tokens row id). The signature lets the gate accept the token
// statelessly; the row makes it revocable.

const MOBILE_TOKEN_TTL_SECONDS = ONE_YEAR_SECONDS;

/** Web-client bearer TTL — 30 days idle-max. Shorter than the mobile year
 *  because browsers refresh opportunistically (see /api/auth/token/refresh):
 *  an active browser rotates well before expiry; an idle one dies in ≤30d. */
export const WEB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Mint a per-device mobile bearer token. Caller inserts the matching
 *  mobile_tokens row keyed by `jti`. `ttlSeconds` defaults to the mobile
 *  year; the web client passes WEB_TOKEN_TTL_SECONDS. */
export function buildMobileToken(
  userId: string,
  jti: string,
  ttlSeconds: number = MOBILE_TOKEN_TTL_SECONDS,
): { value: string; expiresInSec: number; expiresAt: Date } {
  const { value, exp } = signClaims({ uid: userId, jti, k: 'm' }, ttlSeconds);
  return { value, expiresInSec: ttlSeconds, expiresAt: new Date(exp * 1000) };
}

export type MobileClaims = { uid: string; jti: string; exp: number };

/** Verify a mobile token's signature, expiry and kind. No DB — the caller must
 *  still confirm the mobile_tokens row is present and unrevoked. */
export function verifyMobileToken(token: string): MobileClaims | null {
  const claims = verifySigned(token, 'm');
  if (!claims || typeof claims.uid !== 'string' || typeof claims.jti !== 'string') return null;
  return { uid: claims.uid, jti: claims.jti, exp: claims.exp };
}

/** Extract the `jti` from a (valid) mobile token — used by logout to revoke. */
export function mobileTokenJti(token: string): string | null {
  return verifyMobileToken(token)?.jti ?? null;
}

// ── Asset access tokens (`k:'a'`) ────────────────────────────────────────────
// Short-lived, owner-scoped, stateless token for browser-native asset sources —
// `<img>`/`<iframe>`/download `src`s to `/api/files/files/[id]?raw=1` and
// `/api/attachments/[id]` — which CANNOT carry an Authorization header, so a
// detached/Electron client (cross-origin, no cookie) can't otherwise load them.
// Delivered in the URL (`?at=`), so the TTL is deliberately short to bound a
// leaked URL; no revocation row (unlike mobile tokens) — TTL + secret rotation
// is the kill switch. Scope is byte-serving only: the gate accepts it for asset
// paths exclusively, and the session verifier rejects any kinded token.

const ASSET_TOKEN_TTL_SECONDS = 2 * 60 * 60; // 2h — one working session.

/** Mint a short-lived asset-access token for `userId` (see block comment). */
export function buildAssetToken(userId: string): string {
  return signClaims({ uid: userId, k: 'a' }, ASSET_TOKEN_TTL_SECONDS).value;
}

/** Verify an asset token's signature, expiry and kind (`k:'a'`). No DB. */
export function verifyAssetToken(token: string): { uid: string } | null {
  const claims = verifySigned(token, 'a');
  return claims && typeof claims.uid === 'string' ? { uid: claims.uid } : null;
}

// ── Team-visitor cookies (`k:'t'`) ───────────────────────────────────────────
// Set after a team member enters their contact team token on a TEAM-mode app
// share (/s/<token>). Payload binds the visitor to ONE share (`sh` = shares.id)
// and carries WHO they are (`cid` = contact node id) for the audit trail. The
// cookie is path-scoped to that share's /s/<token> — it authenticates nothing
// else, and the session verifier rejects any kinded token, so it can never
// escalate. Stateless signature + expiry here; LIVENESS (is this contact still
// a team member?) is re-checked against contact_team_tokens on every broker
// request, so revoking membership kills the session immediately.

export const TEAM_VISITOR_COOKIE = 'mantle_team';
const TEAM_VISITOR_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, then re-enter the token.

/** Mint the team-visitor cookie value for a share + contact pair. */
export function buildTeamVisitorCookie(
  shareId: string,
  contactId: string,
): { value: string; maxAgeSec: number } {
  const { value } = signClaims({ sh: shareId, cid: contactId, k: 't' }, TEAM_VISITOR_TTL_SECONDS);
  return { value, maxAgeSec: TEAM_VISITOR_TTL_SECONDS };
}

/** Verify a team-visitor cookie value: signature, expiry, kind (`k:'t'`). No DB
 *  — callers must still confirm the share matches and membership is live. */
export function verifyTeamVisitorValue(
  value: string,
): { shareId: string; contactId: string } | null {
  const claims = verifySigned(value, 't');
  if (!claims || typeof claims.sh !== 'string' || typeof claims.cid !== 'string') return null;
  return { shareId: claims.sh, contactId: claims.cid };
}

// ── Team-chat cookies (`k:'c'`) ──────────────────────────────────────────────
// Set after a team member enters their contact team token on the /team chat
// surface. Unlike the app-share visitor cookie (`k:'t'`, bound to ONE share and
// path-scoped to it), this is BRAIN-LEVEL: the claims carry who they are
// (`cid`) and whose brain (`own`), and the cookie rides `/` so it reaches both
// /team (the page) and /api/team/* (the routes). Safe at path `/` because the
// only verifier that accepts kind 'c' is verifyTeamChatValue below — the
// session/mobile/asset verifiers all reject it — so it can never escalate.
// Stateless signature + expiry here; LIVENESS is re-checked on every request.

export const TEAM_CHAT_COOKIE = 'mantle_team_chat';
const TEAM_CHAT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, then re-enter the token.

/**
 * Mint the signed team-chat credential for an (owner, contact) pair. One
 * format, two carriers: same-origin browsers get it as the `mantle_team_chat`
 * cookie value; the split client app holds it in localStorage and sends it as
 * `Authorization: Bearer` (resolveTeamChatCaller verifies both identically).
 */
export function buildTeamChatToken(
  ownerId: string,
  contactId: string,
): { value: string; maxAgeSec: number; expiresAt: number } {
  const { value, exp } = signClaims(
    { own: ownerId, cid: contactId, k: 'c' },
    TEAM_CHAT_TTL_SECONDS,
  );
  return { value, maxAgeSec: TEAM_CHAT_TTL_SECONDS, expiresAt: exp };
}

/** Mint the team-chat cookie value for an (owner, contact) pair. */
export function buildTeamChatCookie(
  ownerId: string,
  contactId: string,
): { value: string; maxAgeSec: number } {
  const { value, maxAgeSec } = buildTeamChatToken(ownerId, contactId);
  return { value, maxAgeSec };
}

/** Verify a team-chat cookie value: signature, expiry, kind (`k:'c'`). No DB —
 *  callers must still confirm membership is live (isTeamMember). */
export function verifyTeamChatValue(value: string): { ownerId: string; contactId: string } | null {
  const claims = verifySigned(value, 'c');
  if (!claims || typeof claims.own !== 'string' || typeof claims.cid !== 'string') return null;
  return { ownerId: claims.own, contactId: claims.cid };
}

/**
 * Decode a signed value WITHOUT verifying it. The one legitimate use is
 * detached dev, where the bearer was signed by a REMOTE Mantle whose secret we
 * do not hold — see detachedDevUser, which is hard-disabled in production.
 * Never use this to make an access decision.
 */
export function decodeUnverifiedClaims(token: string): Record<string, unknown> | null {
  try {
    const dot = token.lastIndexOf('.');
    const payload = dot > 0 ? token.slice(0, dot) : token;
    const data: unknown = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}
