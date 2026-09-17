/**
 * Resolving WHO is calling — the stateful half of lib/auth.
 *
 * Where ./tokens is pure crypto over a string, this module reads the ambient
 * request context (cookies, headers), looks identities up in the database, and
 * builds HTTP responses. Single-user session cookie first, mobile bearer
 * second; both land on the same SessionUser.
 */
import { cookies, headers } from '../../server/http-compat/headers';
import { NextResponse } from '../../server/http-compat';
import { RedirectError } from '../../server/http-compat/redirect-error';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db, authUsers, mobileTokens, countUsers } from '@mantle/db';
import {
  isDetachedDev,
  isAuditSelfLogged,
  MANTLE_PATH_HEADER,
  MANTLE_METHOD_HEADER,
} from '../auth-constants';
import { auditFireAndForget } from '../audit';
import { bearerFromHeader } from './request';
import {
  SESSION_COOKIE_NAME,
  decodeUnverifiedClaims,
  verifyAssetToken,
  verifyMobileToken,
  verifySessionCookie,
} from './tokens';
import { env } from '@mantle/config';

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
    // mutation/audit choke point. `act` names the LOGIN the token was minted
    // for, so per-login asset routes (the profile photo) can address that
    // row; absent, the actor is the anchor itself — the pre-claim behavior.
    if (claims) {
      return {
        id: claims.uid,
        email: '',
        actor: { id: claims.act ?? claims.uid, email: '', displayName: null, isOwner: false },
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
  const token = bearerFromHeader((await headers()).get('authorization'));
  if (!token) return null;
  const claims = verifyMobileToken(token);
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

/**
 * DB-less dev identity. When the frontend is detached (pointed at a remote API
 * via `NEXT_PUBLIC_MANTLE_API_BASE` with a `NEXT_PUBLIC_MANTLE_API_TOKEN`
 * bearer), the browser fetches all data straight from the remote — so the local
 * server has no Postgres and the usual `authUsers` lookup would crash. This
 * stands in for that lookup: it *decodes* (does NOT verify — the token is signed
 * by the remote, not us) the bearer to learn which user the detached client acts
 * as, so the local page auth gate agrees with the remote data the client sees.
 *
 * Because it trusts a decoded-but-unverified token, the activation gate is a
 * SERVER-ONLY flag (`isDetachedDev` → `MANTLE_DETACHED_DEV`, never a
 * `NEXT_PUBLIC_` var an attacker could set from a client bundle) AND it is
 * hard-disabled in production. So this can never grant access in a prod build.
 * See docs/db-less-dev.md. Email isn't in the token; `MANTLE_DEV_EMAIL`
 * overrides the placeholder for the few surfaces that show it.
 */
function detachedDevUser(): SessionUser | null {
  if (!isDetachedDev()) return null;
  const token = env('MANTLE_API_TOKEN')?.trim();
  if (!token) return null;
  const claims = decodeUnverifiedClaims(token);
  if (!claims || typeof claims.uid !== 'string') return null;
  const email = env('MANTLE_DEV_EMAIL')?.trim() || 'dev@localhost';
  return {
    id: claims.uid,
    email,
    actor: { id: claims.uid, email, displayName: null, isOwner: true },
  };
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
export async function getSessionUserWithSource(): Promise<{
  user: SessionUser;
  source: AuthSource;
} | null> {
  // DB-less dev: a detached frontend has no local Postgres, so the configured
  // remote identity stands in for the cookie→authUsers lookup. No-op in prod.
  const dev = detachedDevUser();
  if (dev) return { user: dev, source: 'web' };

  const c = (await cookies()).get(SESSION_COOKIE_NAME);
  if (c) {
    const data = verifySessionCookie(c.value);
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

/** Control-flow login redirect (was next/navigation's redirect signal) — the
 *  Hono app's onError turns a RedirectError into a real 307. */
function redirect(to: string): never {
  throw new RedirectError(to);
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
 * A revoked or expired bearer slips past the stateless gate (revocation is
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
