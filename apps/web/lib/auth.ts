import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db, authUsers, mobileTokens, countUsers } from '@mantle/db';
import {
  SESSION_COOKIE_NAME,
  isDetachedDev,
  isAuditSelfLogged,
  MANTLE_PATH_HEADER,
  MANTLE_METHOD_HEADER,
} from './auth-constants';
import { auditFireAndForget } from './audit';

/**
 * Single-user session cookie auth. Cookie value: `<payload>.<sig>` where
 *   payload = base64url(JSON.stringify({uid, exp}))
 *   sig     = base64url(HMAC_SHA256(SESSION_SECRET, payload))
 *
 * Stateless — no session table. To invalidate everything in one shot, rotate
 * SESSION_SECRET in .env.local and all existing cookies fail verification on
 * the next request.
 */

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Fresh install? (empty `auth.users`). Drives the login screen's
 * sign-in-vs-create-account split. The signup endpoint enforces the same
 * single-user gate server-side; this is only the UI hint.
 */
export async function isFirstRun(): Promise<boolean> {
  // Detached dev has no local DB — never the first-run path, and querying would
  // throw. (Pages should resolve identity via detachedDevUser before reaching
  // here; this is belt-and-suspenders so /login can't 500 in remote mode.)
  if (isDetachedDev()) return false;
  return (await countUsers()) === 0;
}

/**
 * The logged-in LOGIN — who is acting. Multi-admin logins (0111) share one
 * brain: content queries always use the anchor's id, but the actor is what the
 * audit trail records.
 */
export type Actor = {
  id: string;
  email: string;
  displayName: string | null;
  isOwner: boolean;
};

/**
 * `id`/`email` keep their historical role as "whose data" — `id` is ALWAYS the
 * anchor account's id (all content is keyed to it), so the 280+ existing
 * `getOwnerOr401().id` call sites keep querying the one brain no matter who is
 * logged in. `email` is the ACTOR's (display + audit surfaces). Anything
 * login-personal (own password, audit attribution) must use `actor.id`.
 */
export type SessionUser = { id: string; email: string; actor: Actor };

/** How a request authenticated: a session cookie is the web browser; a mobile
 *  bearer token is the companion app. Maps 1:1 onto the inbound
 *  ConversationChannel for web/mobile turns, so a reply/reminder can follow the
 *  surface the user is actually on. See docs/reminder-delivery-routing.md. */
export type AuthSource = 'web' | 'mobile';

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

function sign(payload: string): string {
  const sig = createHmac('sha256', secret()).update(payload).digest();
  return `${payload}.${b64urlEncode(sig)}`;
}

function verify(token: string): { uid: string; exp: number } | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const got = b64urlDecode(sigPart);
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString('utf8'));
    // A session cookie must be a cookie — never a kinded token reused as one.
    // Mobile (`k:'m'`) and asset (`k:'a'`) tokens share the `{uid,exp}` payload,
    // so without this a signed mobile token in the cookie would authenticate via
    // this DB-lookup path (which never checks mobile_tokens.revoked_at, dodging
    // a mobile-logout revocation), and an asset token would grant full session
    // access instead of just byte-serving. Cookies carry no `k`; reject any.
    if (data.k !== undefined) return null;
    if (typeof data.uid !== 'string' || typeof data.exp !== 'number') return null;
    if (Date.now() / 1000 > data.exp) return null;
    return { uid: data.uid, exp: data.exp };
  } catch {
    return null;
  }
}

export function buildSessionCookie(userId: string): { value: string; maxAgeSec: number } {
  const exp = Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS;
  const payload = b64urlEncode(Buffer.from(JSON.stringify({ uid: userId, exp }), 'utf8'));
  return { value: sign(payload), maxAgeSec: ONE_YEAR_SECONDS };
}

// ── Mobile companion bearer tokens ───────────────────────────────────────────
// Same signed format as the session cookie, but the payload carries a `jti`
// (the mobile_tokens row id) and a kind marker `k:'m'`. The signature lets the
// Edge middleware accept the token statelessly; the row makes it revocable.

const MOBILE_TOKEN_TTL_SECONDS = ONE_YEAR_SECONDS;

/** Mint a per-device mobile bearer token. Caller inserts the matching
 *  mobile_tokens row keyed by `jti`. */
export function buildMobileToken(
  userId: string,
  jti: string,
): { value: string; expiresInSec: number; expiresAt: Date } {
  const expEpoch = Math.floor(Date.now() / 1000) + MOBILE_TOKEN_TTL_SECONDS;
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ uid: userId, exp: expEpoch, jti, k: 'm' }), 'utf8'),
  );
  return {
    value: sign(payload),
    expiresInSec: MOBILE_TOKEN_TTL_SECONDS,
    expiresAt: new Date(expEpoch * 1000),
  };
}

type MobileClaims = { uid: string; jti: string; exp: number };

/** Verify a mobile token's signature, expiry and kind. No DB. */
function verifyMobileToken(token: string): MobileClaims | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const got = b64urlDecode(sigPart);
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (data.k !== 'm') return null;
    if (
      typeof data.uid !== 'string' ||
      typeof data.jti !== 'string' ||
      typeof data.exp !== 'number'
    ) {
      return null;
    }
    if (Date.now() / 1000 > data.exp) return null;
    return { uid: data.uid, jti: data.jti, exp: data.exp };
  } catch {
    return null;
  }
}

/** Extract the `jti` from a (valid) mobile token — used by logout to revoke. */
export function mobileTokenJti(token: string): string | null {
  return verifyMobileToken(token)?.jti ?? null;
}

// ── Asset access tokens (`k:'a'`) ─────────────────────────────────────────────
// Short-lived, owner-scoped, stateless signed token for browser-native asset
// sources — `<img>`/`<iframe>`/download `src`s to `/api/files/files/[id]?raw=1`
// and `/api/attachments/[id]` — which CANNOT carry an Authorization header, so a
// detached/Electron client (cross-origin, no cookie) can't otherwise load them.
// Delivered in the URL (`?at=`), so the TTL is deliberately short to bound a
// leaked URL; no revocation row (unlike mobile tokens) — TTL + secret-rotation
// is the kill switch. Scope is byte-serving only: the Edge middleware accepts it
// for asset paths exclusively, and the cookie path rejects any kinded token.

const ASSET_TOKEN_TTL_SECONDS = 2 * 60 * 60; // 2h — one working session.

/** Mint a short-lived asset-access token for `userId` (see block comment). */
export function buildAssetToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + ASSET_TOKEN_TTL_SECONDS;
  const payload = b64urlEncode(Buffer.from(JSON.stringify({ uid: userId, exp, k: 'a' }), 'utf8'));
  return sign(payload);
}

/** Verify an asset token's signature, expiry and kind (`k:'a'`). No DB. */
function verifyAssetToken(token: string): { uid: string } | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const got = b64urlDecode(token.slice(dot + 1));
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (data.k !== 'a') return null;
    if (typeof data.uid !== 'string' || typeof data.exp !== 'number') return null;
    if (Date.now() / 1000 > data.exp) return null;
    return { uid: data.uid };
  } catch {
    return null;
  }
}

// ── Team-visitor cookies (`k:'t'`) ───────────────────────────────────────────
// Set after a team member enters their contact team token on a TEAM-mode app
// share (/s/<token>). Payload binds the visitor to ONE share (`sh` = shares.id)
// and carries WHO they are (`cid` = contact node id) for the audit trail. The
// cookie is path-scoped to that share's /s/<token> — it authenticates nothing
// else, and the session-cookie verifier rejects any kinded token, so it can
// never escalate. Statless signature + expiry here; LIVENESS (is this contact
// still a team member?) is re-checked against contact_team_tokens on every
// broker request, so revoking membership kills the session immediately.

export const TEAM_VISITOR_COOKIE = 'mantle_team';
const TEAM_VISITOR_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, then re-enter the token.

/** Mint the team-visitor cookie value for a share + contact pair. */
export function buildTeamVisitorCookie(
  shareId: string,
  contactId: string,
): { value: string; maxAgeSec: number } {
  const exp = Math.floor(Date.now() / 1000) + TEAM_VISITOR_TTL_SECONDS;
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ sh: shareId, cid: contactId, exp, k: 't' }), 'utf8'),
  );
  return { value: sign(payload), maxAgeSec: TEAM_VISITOR_TTL_SECONDS };
}

/** Verify a team-visitor cookie value: signature, expiry, kind (`k:'t'`). No DB
 *  — callers must still confirm the share matches and membership is live. */
export function verifyTeamVisitorValue(
  value: string,
): { shareId: string; contactId: string } | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const got = b64urlDecode(value.slice(dot + 1));
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (data.k !== 't') return null;
    if (typeof data.sh !== 'string' || typeof data.cid !== 'string' || typeof data.exp !== 'number') {
      return null;
    }
    if (Date.now() / 1000 > data.exp) return null;
    return { shareId: data.sh, contactId: data.cid };
  } catch {
    return null;
  }
}

/**
 * Owner gate for the byte-serving asset routes only. Resolves the session
 * (cookie/bearer) first; failing that, accepts a valid `?at=` asset token in the
 * URL — the one place a browser-native `src` can convey auth. Owner-scoped: the
 * route still scopes the lookup to the returned id, so a token for user X only
 * reaches X's bytes. Returns a 401 JSON `Response` like `getOwnerOr401`.
 */
export async function getOwnerForAsset(req: Request): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  if (user) return user;
  const at = new URL(req.url).searchParams.get('at');
  if (at) {
    const claims = verifyAssetToken(at);
    // The signature proves the server minted this for `uid`; the route scopes to
    // it. No DB lookup — the token is short-lived and email isn't needed here.
    // Byte-serving is GET-only, so the synthetic actor never reaches the
    // mutation/audit choke point.
    if (claims) {
      return {
        id: claims.uid,
        email: '',
        actor: { id: claims.uid, email: '', displayName: null, isOwner: false },
      };
    }
  }
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * Resolve the owner from an `Authorization: Bearer <mobile-token>` header:
 * verify the signature, confirm the row is present/unrevoked/unexpired, bump
 * last_used_at. Returns null on any failure.
 */
async function getBearerUser(): Promise<SessionUser | null> {
  const auth = (await headers()).get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return null;
  const claims = verifyMobileToken(m[1]!.trim());
  if (!claims) return null;

  const [tok] = await db
    .select({ revokedAt: mobileTokens.revokedAt, expiresAt: mobileTokens.expiresAt })
    .from(mobileTokens)
    .where(eq(mobileTokens.id, claims.jti))
    .limit(1);
  if (!tok || tok.revokedAt) return null;
  if (tok.expiresAt.getTime() <= Date.now()) return null;

  const [row] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      isOwner: authUsers.isOwner,
      displayName: authUsers.displayName,
    })
    .from(authUsers)
    .where(eq(authUsers.id, claims.uid))
    .limit(1);
  if (!row || !row.email) return null;

  await db
    .update(mobileTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mobileTokens.id, claims.jti));

  return sessionUserFor(row);
}

export { SESSION_COOKIE_NAME };

/**
 * DB-less dev identity. When the frontend is detached (pointed at a remote API
 * via `NEXT_PUBLIC_MANTLE_API_BASE` with a `NEXT_PUBLIC_MANTLE_API_TOKEN`
 * bearer), the browser fetches all data straight from the remote — so the local
 * Next server has no Postgres and the usual `authUsers` lookup would crash. This
 * stands in for that lookup: it *decodes* (does NOT verify — the token is signed
 * by the remote, not us) the bearer to learn which user the detached client acts
 * as, so the local page auth gate agrees with the remote data the client sees.
 *
 * Because it trusts a decoded-but-unverified token, the activation gate is a
 * SERVER-ONLY flag (`isDetachedDev` → `MANTLE_DETACHED_DEV`, never a
 * `NEXT_PUBLIC_` var an attacker could set from a client bundle) AND it is
 * hard-disabled in production. So this can never grant access in a prod build.
 * The companion bypass in `middleware.ts` gates on the same `isDetachedDev()`.
 * See docs/db-less-dev.md. Email isn't in the token; `MANTLE_DEV_EMAIL`
 * overrides the placeholder for the few surfaces that show it.
 */
function detachedDevUser(): SessionUser | null {
  if (!isDetachedDev()) return null;
  const token = process.env.NEXT_PUBLIC_MANTLE_API_TOKEN?.trim();
  if (!token) return null;
  try {
    const dot = token.lastIndexOf('.');
    const payload = dot > 0 ? token.slice(0, dot) : token;
    const data = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (typeof data.uid !== 'string') return null;
    const email = process.env.MANTLE_DEV_EMAIL?.trim() || 'dev@localhost';
    return {
      id: data.uid,
      email,
      actor: { id: data.uid, email, displayName: null, isOwner: true },
    };
  } catch {
    return null;
  }
}

// ── Actor → anchor mapping ────────────────────────────────────────────────────
// All brain content is keyed to the ANCHOR account (is_owner). The anchor id is
// immutable by construction — the row can't be deleted and the partial unique
// index allows exactly one — so a module-level forever-cache is safe.
let anchorIdCache: string | null = null;

async function getAnchorId(): Promise<string | null> {
  if (anchorIdCache) return anchorIdCache;
  const [row] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.isOwner, true))
    .limit(1);
  if (row) anchorIdCache = row.id;
  return anchorIdCache;
}

type ActorRow = {
  id: string;
  email: string;
  isOwner: boolean;
  displayName: string | null;
};

/** Assemble the SessionUser for a resolved login row: actor = the login,
 *  id = the anchor the brain's data is keyed to. */
async function sessionUserFor(row: ActorRow): Promise<SessionUser | null> {
  const anchorId = row.isOwner ? row.id : await getAnchorId();
  // A non-anchor login with no anchor in the DB is a corrupt state (0111
  // guarantees one) — refuse the session rather than mis-scope queries.
  if (!anchorId) return null;
  return {
    id: anchorId,
    email: row.email,
    actor: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      isOwner: row.isOwner,
    },
  };
}

/** Resolve the current user AND how they authenticated. Cookie first ('web'),
 *  then a mobile bearer ('mobile'). Returns null when neither resolves. The
 *  source is what lets a turn be tagged with the right ConversationChannel. */
export async function getSessionUserWithSource(): Promise<
  { user: SessionUser; source: AuthSource } | null
> {
  // DB-less dev: a detached frontend has no local Postgres, so the configured
  // remote identity stands in for the cookie→authUsers lookup. No-op in prod.
  const dev = detachedDevUser();
  if (dev) return { user: dev, source: 'web' };

  const c = (await cookies()).get(SESSION_COOKIE_NAME);
  if (c) {
    const data = verify(c.value);
    if (data) {
      const [row] = await db
        .select({
          id: authUsers.id,
          email: authUsers.email,
          isOwner: authUsers.isOwner,
          displayName: authUsers.displayName,
        })
        .from(authUsers)
        .where(eq(authUsers.id, data.uid))
        .limit(1);
      if (row && row.email) {
        const user = await sessionUserFor(row);
        if (user) return { user, source: 'web' };
      }
    }
  }
  // Mobile companion: Authorization: Bearer <mobile-token>.
  const bearer = await getBearerUser();
  return bearer ? { user: bearer, source: 'mobile' } : null;
}

/** Returns the current user, or null. Safe in Server Components.
 *  Resolves a session cookie first; falls back to a mobile bearer token so
 *  every handler that already calls this also accepts the mobile companion. */
export async function getSessionUser(): Promise<SessionUser | null> {
  return (await getSessionUserWithSource())?.user ?? null;
}

/** Gate for protected pages. Redirects to /login if no session. */
export async function requireOwner(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return user;
}

/** Like `requireOwner()` but also reports how the request authenticated, so the
 *  caller can tag the turn's ConversationChannel ('web' vs 'mobile'). */
export async function requireOwnerWithSource(): Promise<{ user: SessionUser; source: AuthSource }> {
  const res = await getSessionUserWithSource();
  if (!res) redirect('/login');
  return res;
}

/**
 * Owner gate for JSON API routes (the mobile companion). Unlike
 * `requireOwner()`, which `redirect()`s to /login — a 307 to an HTML page,
 * wrong for a programmatic client — this returns a 401 JSON response the caller
 * returns as-is:
 *
 *     const owner = await getOwnerOr401();
 *     if (owner instanceof NextResponse) return owner;
 *     // owner: SessionUser
 *
 * A revoked or expired bearer slips past the stateless Edge gate (revocation is
 * enforced here in the Node layer), so this is where it's caught — now as a
 * clean 401 instead of a redirect.
 */
export async function getOwnerOr401(): Promise<SessionUser | NextResponse> {
  const res = await getOwnerOr401WithSource();
  return res instanceof NextResponse ? res : res.user;
}

/**
 * Audit hook, shared by both `getOwnerOr401` variants — which every /api/**
 * route calls first. For mutating methods (learned from the middleware-injected
 * x-mantle-method/-path headers, which clients can't spoof) it fire-and-forgets
 * a generic `api.write` row recording who did what — unless the route logs its
 * own richer event (`AUDIT_SELF_LOGGED_PATHS`). Reads (GET/HEAD) aren't logged.
 */
async function auditMutation(user: SessionUser): Promise<void> {
  const h = await headers();
  const method = (h.get(MANTLE_METHOD_HEADER) ?? '').toUpperCase();
  const path = h.get(MANTLE_PATH_HEADER) ?? '';
  const mutating = method !== '' && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (!mutating || isAuditSelfLogged(path)) return;
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'api.write',
    method,
    path,
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    userAgent: h.get('user-agent') || null,
  });
}

/**
 * Like `getOwnerOr401()` but also reports how the request authenticated
 * ('web' cookie vs 'mobile' bearer), for routes that tag a turn's
 * ConversationChannel. The 401-instead-of-redirect contract is what an API
 * route needs (vs `requireOwnerWithSource()`, which redirects):
 *
 *     const auth = await getOwnerOr401WithSource();
 *     if (auth instanceof NextResponse) return auth;
 *     const { user, source } = auth;
 */
export async function getOwnerOr401WithSource(): Promise<
  { user: SessionUser; source: AuthSource } | NextResponse
> {
  const res = await getSessionUserWithSource();
  if (!res) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await auditMutation(res.user);
  return res;
}

/**
 * Verify email+password against auth.users. Returns the user id on match,
 * null otherwise. Pure DB-driven — no external auth service.
 */
export async function loginWithPassword(email: string, password: string): Promise<string | null> {
  // Case-insensitive match — emails are case-insensitive in practice, and a
  // user who signed up "Jay@X.com" must be able to log in as "jay@x.com".
  // Handles any casing already stored (incl. legacy manually-inserted rows).
  const [row] = await db
    .select({ id: authUsers.id, hash: authUsers.passwordHash })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = lower(${email})`)
    .limit(1);
  if (!row || !row.hash) return null;
  const ok = await bcrypt.compare(password, row.hash);
  return ok ? row.id : null;
}

/** Update password hash. Caller is responsible for verifying the old password first. */
export async function updatePassword(userId: string, newPassword: string): Promise<void> {
  const hash = await bcrypt.hash(newPassword, 12);
  await db.update(authUsers).set({ passwordHash: hash }).where(eq(authUsers.id, userId));
}

export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const [row] = await db
    .select({ hash: authUsers.passwordHash })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  if (!row || !row.hash) return false;
  return bcrypt.compare(password, row.hash);
}
