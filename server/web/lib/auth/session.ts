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
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import {
  db,
  accessKeys,
  authUsers,
  mobileTokens,
  oauthAccessTokens,
  oauthAuthCodes,
  pushSubscriptions,
  countUsers,
  isBusy,
  isWriteRefused,
  pgErrorCode,
} from '@mantle/db';
import {
  loadAnchorId,
  loadBearerToken,
  loadLoginRow,
  loadPersonalSpaceId,
  touchBearerToken,
  type LoginRow,
} from './login-row';
import {
  isDetachedDev,
  isAuditSelfLogged,
  isClientAppBrokerPath,
  isRenderAssetPath,
  MANTLE_PATH_HEADER,
  MANTLE_METHOD_HEADER,
  RENDER_COOKIE_NAME,
  secureCookies,
} from '../auth-constants';
import { auditFireAndForget, requestMeta } from '../audit';
import { lockOauthActor } from '../oauth-lock';
import { auditPeersUnbound, unbindPeersActingAs } from '../peer-unbind';
import { isAccessKey, isApiV1Path, lockLoginKeys } from '../access-keys';
import { keyMayCall, matchApiV1Route } from '../api-v1';
import { getRequestContext } from '../../server/request-context';
import { bearerFromHeader } from './request';
import {
  SESSION_COOKIE_NAME,
  buildAssetToken,
  buildSessionCookie,
  decodeUnverifiedClaims,
  verifyAssetToken,
  verifyMobileToken,
  verifyRenderToken,
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
 *  bearer token is the phone app (any role) or the split web client. Maps 1:1 onto the inbound
 *  ConversationChannel for web/mobile turns, so a reply/reminder can follow the
 *  surface the user is actually on. See docs/reminder-delivery-routing.md.
 *  'api' is an inbound API key on /api/v1 (no conversation route is there). */
export type AuthSource = 'web' | 'mobile' | 'api';

/**
 * A MEMBER login (member logins, Phase 1). Deliberately has no `id`: the 280+
 * call sites that scope by `user.id` cannot take a member by mistake, because
 * the type checker refuses it. A member reaches only the member routes, which
 * read at the team level through RLS (`withViewer('team', …)`).
 */
export type MemberCaller = {
  role: 'member';
  /** The login row (auth.users.id): own password, own thread, audit. */
  loginId: string;
  /** The brain the member belongs to (the anchor's id). */
  anchorId: string;
  /** The login's personal space (Phase 2): what their own items are keyed
   *  to. Work on it only inside `withSpace` (lib/member-space.ts). */
  spaceId: string;
  email: string;
  displayName: string | null;
  contactId: string | null;
};

/**
 * A CLIENT login (client logins): a person at the brain's one client
 * company. It reaches only the routes in CLIENT_ROUTES (lib/auth/
 * client-routes.ts), through getClientOr401, and reads at the client level;
 * every admin and member gate refuses it with reason `client-login`. Like
 * MemberCaller it has no `.id`, so no anchor-scoped call site can take it by
 * mistake.
 */
export type ClientCaller = {
  role: 'client';
  loginId: string;
  anchorId: string;
  /** The login's personal space (every login has one, 0165). Client drafts
   *  come in Phase C5; nothing writes here before then. */
  spaceId: string;
  email: string;
  displayName: string | null;
  /** The login's session epoch, from the row the session was checked
   *  against: work that outlives the request (a queued client chat turn, C4)
   *  runs only while it is still the login's epoch (clientTurnMayRun). */
  sessionEpoch: number;
};
/** How long a client session lasts (plan section 4): 30 days, not a year.
 *  The cookie is minted with it, and a client cookie that claims to last
 *  longer is refused, whoever signed it. */
export const CLIENT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** How long a client's DEVICE token may be kept alive by refresh, counted
 *  from the emailed code that signed the phone in: 90 days. After it the
 *  person asks for a new code. (A browser session does not refresh: it ends
 *  at 30 days.) */
export const CLIENT_DEVICE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
/** POST /api/auth/token/refresh rotates a token only when less than this is
 *  left (23 of a 30-day token's days); before that it answers the same
 *  token, so a caller that loops on refresh writes no rows. */
export const ROTATE_WHEN_UNDER_SECONDS = 23 * 24 * 60 * 60;

/** Whether a login row may hold a session at all: not disabled, and it has
 *  an email. Admin and member alike (member logins are always on since
 *  Phase 6; the MANTLE_MEMBERS flag is gone). */
export function loginUsable(row: Pick<LoginRow, 'disabledAt' | 'email'>): boolean {
  return !!row.email && !row.disabledAt;
}

/** Who is calling, resolved from the login row: an admin (today's
 *  SessionUser), a member or a client. `epoch`: the login's session epoch
 *  on the row the credential was just checked against. */
type Resolved =
  | { kind: 'admin'; user: SessionUser; source: AuthSource; epoch: number }
  | { kind: 'member'; member: MemberCaller; source: AuthSource; epoch: number }
  | { kind: 'client'; client: ClientCaller; source: AuthSource; epoch: number };

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
      // The login the token was minted for (`act`, else the anchor itself)
      // must still be a usable ADMIN on the same session epoch. Members are
      // never minted one; this closes a revoked, demoted or signed-out
      // login's 2-hour window too.
      const row = await loadLoginRow(claims.act ?? claims.uid);
      if (!row || row.role !== 'admin' || !loginUsable(row) || row.sessionEpoch !== claims.ep) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
      return {
        id: claims.uid,
        email: '',
        actor: { id: claims.act ?? claims.uid, email: '', displayName: null, isOwner: false },
      };
    }
  }
  // The browser sidecar rendering an export: the render cookie, on the byte
  // routes a render surface loads (page images, scene images, embedded
  // drawings) and nowhere else. The admin private-space bytes are not among
  // them, so a printed page can never pull a private item.
  if (req.method === 'GET' && isRenderAssetPath(new URL(req.url).pathname)) {
    const render = await renderCaller();
    if (render) return render.user;
  }
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * The admin a render cookie (kind 'r', lib/auth/tokens.ts) was minted for,
 * and the node it may open. The login is re-read: a disabled or demoted
 * login's cookie stops at once, and a cookie naming another brain's anchor
 * never matches. Null when the request carries no valid render cookie.
 */
async function renderCaller(): Promise<{ user: SessionUser; nodeId: string } | null> {
  const value = (await cookies()).get(RENDER_COOKIE_NAME)?.value;
  const claims = value ? verifyRenderToken(value) : null;
  if (!claims) return null;
  const row = await loadLoginRow(claims.act);
  if (!row || row.role !== 'admin' || !loginUsable(row)) return null;
  const user = await sessionUserFor(row);
  if (!user || user.id !== claims.uid) return null;
  return { user, nodeId: claims.n };
}

/**
 * The member twin of getOwnerForAsset, for the member Library's byte routes:
 * a member session, or a `?at=` token minted for a member login (the member
 * shell mints it with `act` = the login). The login is re-read, so a disabled
 * or demoted login's token stops at once. The route reads at the team level.
 */
export async function getMemberForAsset(req: Request): Promise<MemberCaller | NextResponse> {
  const res = await resolveLogin();
  if (res?.kind === 'member') return res.member;
  const at = new URL(req.url).searchParams.get('at');
  const claims = at ? verifyAssetToken(at) : null;
  if (claims?.act) {
    const row = await loadLoginRow(claims.act);
    if (row && row.role === 'member' && loginUsable(row) && row.sessionEpoch === claims.ep) {
      const resolved = await resolvedFor(row, 'web');
      if (resolved?.kind === 'member' && resolved.member.anchorId === claims.uid) {
        return resolved.member;
      }
    }
  }
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * Resolve the login from an `Authorization: Bearer <mobile-token>` header:
 * verify the signature, confirm the row is present/unrevoked/unexpired and
 * names the same login, bump last_used_at. Returns null on any failure.
 *
 * A token that carries a session epoch (`ep`: a CLIENT's device token always
 * does) is also held to it: once the login's epoch moves on (sign out, End
 * sessions, disable, a role change) the token is dead, as the client's
 * cookie is. A client token WITHOUT an epoch, or one that claims to last
 * longer than a client session, was not minted by the client sign-in and is
 * refused.
 */
async function getBearerLogin(): Promise<Resolved | null> {
  return (await bearerLogin())?.resolved ?? null;
}

/** getBearerLogin, plus the device token's id (the cookie upgrade binds the
 *  cookie it mints to it). */
async function bearerLogin(): Promise<{ resolved: Resolved; jti: string } | null> {
  const token = bearerFromHeader((await headers()).get('authorization'));
  if (!token) return null;
  const claims = verifyMobileToken(token);
  if (!claims) return null;

  const tok = await loadBearerToken(claims.jti);
  if (!tok || tok.userId !== claims.uid) return null;
  if (tok.revokedAt) {
    // A token a refresh replaced, presented on an ordinary route: when its
    // successor has been used, this is the stolen-from copy (the app holds
    // only the newest), on whatever route it shows up.
    if (tok.rotatedTo) {
      const h = await headers();
      await presentRotatedToken(
        { jti: claims.jti, userId: tok.userId, rotatedTo: tok.rotatedTo },
        {
          method: (h.get(MANTLE_METHOD_HEADER) ?? '').toUpperCase(),
          path: h.get(MANTLE_PATH_HEADER) ?? '',
          meta: await requestMeta(),
        },
      );
    }
    return null;
  }
  if (tok.expiresAt.getTime() <= Date.now()) return null;

  const row = await loadLoginRow(claims.uid);
  if (!row || !loginUsable(row)) return null;
  if (claims.ep !== undefined && claims.ep !== row.sessionEpoch) return null;
  if (row.role === 'client') {
    const latest = Date.now() + (CLIENT_SESSION_TTL_SECONDS + 60) * 1000;
    if (claims.ep === undefined) return null;
    if (claims.exp * 1000 > latest || tok.expiresAt.getTime() > latest) return null;
  }

  await touchBearerToken(claims.jti);

  const resolved = await resolvedFor(row, 'mobile');
  return resolved ? { resolved, jti: claims.jti } : null;
}

/** Most refreshes a cookie's device token can have gone through and still
 *  be followed (each refresh revokes the row and points it at the next). */
const DEVICE_CHAIN_MAX_HOPS = 16;

/**
 * Is the device a cookie was minted from (its `dj` claim) still signed in?
 * A refresh replaces the token row and points the old one at the new, so the
 * chain is followed to its newest row: that row must be live and the same
 * login's. A device revoke (or End sessions) revokes the newest row, and the
 * cookie dies with it (access matrix T2).
 */
async function cookieDeviceAlive(jti: string, uid: string): Promise<boolean> {
  let tok = await loadBearerToken(jti);
  for (let hop = 0; tok?.revokedAt && tok.rotatedTo && hop < DEVICE_CHAIN_MAX_HOPS; hop++) {
    tok = await loadBearerToken(tok.rotatedTo);
  }
  return !!tok && tok.userId === uid && !tok.revokedAt && tok.expiresAt.getTime() > Date.now();
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
  anchorIdCache = await loadAnchorId();
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

/**
 * An admin row becomes a SessionUser (id = the anchor), a member row a
 * MemberCaller, a client row a ClientCaller. Every role is named: a role this
 * code does not know is NO login (null), never an admin (client logins C0:
 * before it, every role that was not member resolved as an admin). Null too
 * when the brain has no anchor (a corrupt state).
 */
async function resolvedFor(row: LoginRow, source: AuthSource): Promise<Resolved | null> {
  const role: string = row.role;
  switch (role) {
    case 'admin': {
      const user = await sessionUserFor(row);
      return user ? { kind: 'admin', user, source, epoch: row.sessionEpoch } : null;
    }
    case 'member': {
      const anchorId = await getAnchorId();
      if (!anchorId) return null;
      const spaceId = await loadPersonalSpaceId(row.id);
      if (!spaceId) return null;
      return {
        kind: 'member',
        source,
        epoch: row.sessionEpoch,
        member: {
          role: 'member',
          loginId: row.id,
          anchorId,
          spaceId,
          email: row.email,
          displayName: row.displayName,
          contactId: row.contactId,
        },
      };
    }
    case 'client': {
      // A browser session, or the phone app's device token (minted only by
      // the emailed code in device mode; getBearerLogin holds it to the
      // login's session epoch and to the 30 days).
      const anchorId = await getAnchorId();
      if (!anchorId) return null;
      const spaceId = await loadPersonalSpaceId(row.id);
      if (!spaceId) return null;
      return {
        kind: 'client',
        source,
        epoch: row.sessionEpoch,
        client: {
          role: 'client',
          loginId: row.id,
          anchorId,
          spaceId,
          email: row.email,
          displayName: row.displayName,
          sessionEpoch: row.sessionEpoch,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * The login an inbound API key (`mtlk_`) acts as. `undefined` when the
 * request carries no key; null when it carries one that is not let in.
 *
 * A key is taken ONLY from the request context, where the gate leaves it
 * after every check passed (server/middleware/access-key-gate.ts: the
 * failed-try budget, the key itself, its rate budget, its scope). It is
 * never verified again here (audit item 3): a request that reached a route
 * without the gate's grant (a public prefix such as /api/auth, or a path
 * shape the gate lets through) has no key login at all.
 *
 * The scope guard runs again here (audit item 1), so a `source: 'api'`
 * login exists only for a /api/v1 route the key may call: the route's
 * area, and a write only for a read_write key. Every gate below
 * (getOwnerOr401, getMemberOr401, getClientOr401, getLoginOr401) resolves
 * through this, so none can hand a read key a write route.
 */
async function accessKeyLogin(): Promise<Resolved | null | undefined> {
  const h = await headers();
  const token = bearerFromHeader(h.get('authorization'));
  if (!isAccessKey(token)) return undefined;
  const ctx = getRequestContext();
  const grant = ctx?.accessKey;
  if (!ctx || !grant) return null;
  if (!isApiV1Path(ctx.path)) return null;
  if (!keyMayCall(grant, matchApiV1Route(ctx.method, ctx.path)).ok) return null;
  return resolvedFor(grant.login, 'api');
}

/** Resolve the calling login, admin or member, cookie first then bearer. */
async function resolveLogin(): Promise<Resolved | null> {
  // DB-less dev: a detached frontend has no local Postgres, so the configured
  // remote identity stands in for the cookie→authUsers lookup. Always an
  // admin. No-op in prod.
  const dev = detachedDevUser();
  if (dev) return { kind: 'admin', user: dev, source: 'web', epoch: 0 };

  // An API key is judged on itself, never with the cookie: a key presented
  // where keys are not accepted is no login at all.
  const key = await accessKeyLogin();
  if (key !== undefined) return key;

  const c = (await cookies()).get(SESSION_COOKIE_NAME);
  if (c) {
    const data = verifySessionCookie(c.value);
    if (data) {
      const row = await loadLoginRow(data.uid);
      // The epoch check is what ends a cookie: a password change, a disable,
      // a role change or "sign out everywhere" bumps the row (F06).
      // A client session lasts 30 days: a client cookie that claims a later
      // expiry was not minted by the client sign-in, and is refused.
      const tooLong =
        row?.role === 'client' &&
        data.exp > Math.floor(Date.now() / 1000) + CLIENT_SESSION_TTL_SECONDS + 60;
      // A cookie the bearer upgrade minted lives only while its device does.
      const deviceOk = !data.dj || (await cookieDeviceAlive(data.dj, data.uid));
      if (row && loginUsable(row) && row.sessionEpoch === data.ep && !tooLong && deviceOk) {
        const resolved = await resolvedFor(row, 'web');
        if (resolved) return resolved;
      }
    }
  }
  // Mobile companion: Authorization: Bearer <mobile-token>.
  return getBearerLogin();
}

/** Resolve the current user AND how they authenticated. Cookie first ('web'),
 *  then a mobile bearer ('mobile'). Returns null when neither resolves. The
 *  source is what lets a turn be tagged with the right ConversationChannel. */
export async function getSessionUserWithSource(): Promise<{
  user: SessionUser;
  source: AuthSource;
} | null> {
  // ADMINS only: every existing caller treats the result as the brain's owner.
  // A member resolves to null here, so no admin path can take one.
  const res = await resolveLogin();
  return res?.kind === 'admin' ? { user: res.user, source: res.source } : null;
}

/** Returns the current ADMIN user, or null (a member is null too). Safe in
 *  Server Components. Resolves a session cookie first; falls back to a mobile
 *  bearer token so every handler that already calls this also accepts the
 *  mobile companion. */
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

/**
 * Gate for the render surfaces (/print/pages, /print/draws, /render/draws).
 * An admin session opens them as before; otherwise the render cookie the
 * browser sidecar carries, and only for the node that cookie names. Redirects
 * to /login like requireOwner.
 */
export async function requireOwnerForRender(nodeId: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user) return user;
  const render = await renderCaller();
  if (render && render.nodeId === nodeId) return render.user;
  redirect('/login');
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
async function auditMutation(user: SessionUser, skip?: (path: string) => boolean): Promise<void> {
  const h = await headers();
  const method = (h.get(MANTLE_METHOD_HEADER) ?? '').toUpperCase();
  const path = h.get(MANTLE_PATH_HEADER) ?? '';
  const mutating = method !== '' && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (!mutating || isAuditSelfLogged(path) || skip?.(path)) return;
  // A write made with an API key names the key (never its secret).
  const key = getRequestContext()?.accessKey;
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'api.write',
    method,
    path,
    // The proxy-appended address, not the caller's leftmost (audit B16).
    ...(await requestMeta()),
    // The key's maker too: a key that acts as a member or client logs its
    // writes under that login, and the maker is who to ask (audit item 8).
    ...(key
      ? { detail: { keyId: key.id, keyPrefix: key.prefix, keyCreatedBy: key.createdBy } }
      : {}),
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
  const res = await resolveLogin();
  if (!res) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Deny by default: every admin gate takes an admin and nothing else. A
  // member or a client is refused (member routes use getMemberOr401 and are
  // listed in MEMBER_ROUTES; the auth sweeps check both).
  if (res.kind !== 'admin') return loginRefused(res.kind);
  await auditMutation(res.user);
  return { user: res.user, source: res.source };
}

/**
 * The client gate (client logins C2): a CLIENT login, or 401 (no session) /
 * 403 (an admin or a member: client routes are client-specific, never a
 * shared route). Only for routes in CLIENT_ROUTES (lib/auth/client-routes.ts);
 * run the handler's reads under `withViewer('client', …)`. A client write is
 * audited like an admin's (`api.write`).
 */
export async function getClientOr401(): Promise<ClientCaller | NextResponse> {
  const res = await resolveLogin();
  if (!res) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (res.kind !== 'client') {
    return NextResponse.json(
      {
        error: 'forbidden',
        reason: res.kind === 'admin' ? 'admin-login' : 'member-login',
        message: 'This route is for client logins.',
      },
      { status: 403 },
    );
  }
  await auditClientMutation(res.client);
  return res.client;
}

async function auditClientMutation(client: ClientCaller): Promise<void> {
  // The app brokers log to the app's access log instead (audit I4).
  await auditMutation(
    {
      id: client.anchorId,
      email: client.email,
      actor: {
        id: client.loginId,
        email: client.email,
        displayName: client.displayName,
        isOwner: false,
      },
    },
    isClientAppBrokerPath,
  );
}

/**
 * The client twin of getMemberForAsset, for the client byte routes: a client
 * session, or a `?at=` token minted for a client login (the client shell
 * mints it with `act` = the login). The login is re-read, so a disabled
 * login, a changed role or an ended session stops the token at once.
 */
export async function getClientForAsset(req: Request): Promise<ClientCaller | NextResponse> {
  const res = await resolveLogin();
  if (res?.kind === 'client') return res.client;
  const at = new URL(req.url).searchParams.get('at');
  const claims = at ? verifyAssetToken(at) : null;
  if (claims?.act) {
    const row = await loadLoginRow(claims.act);
    if (row && row.role === 'client' && loginUsable(row) && row.sessionEpoch === claims.ep) {
      const resolved = await resolvedFor(row, 'web');
      if (resolved?.kind === 'client' && resolved.client.anchorId === claims.uid) {
        return resolved.client;
      }
    }
  }
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/** Is this client login still allowed in? For work that outlives the request
 *  (a queued client turn, Phase C4): the row is re-read, and the session
 *  epoch the work was started under is REQUIRED (audit B24): an admin's End
 *  sessions, or the client's sign-out, must stop the work too. */
export async function clientLoginActive(loginId: string, epoch: number): Promise<boolean> {
  const row = await loadLoginRow(loginId);
  return !!row && row.role === 'client' && loginUsable(row) && row.sessionEpoch === epoch;
}

/** The 403 a gate answers a login of the wrong role with. The reason names
 *  the CALLER's role: `member-login`, `client-login`, or `admin-login` from
 *  a member route. */
export function loginRefused(kind: Resolved['kind']): NextResponse {
  const body =
    kind === 'member'
      ? { reason: 'member-login', message: 'Not available to member logins.' }
      : kind === 'client'
        ? { reason: 'client-login', message: 'Not available to client logins.' }
        : { reason: 'admin-login', message: 'This route is for member logins.' };
  return NextResponse.json({ error: 'forbidden', ...body }, { status: 403 });
}

/**
 * The member gate (member logins, Phase 1): a MEMBER login, or 401 (no
 * session) / 403 (an admin: member routes are member-specific, never a
 * shared owner route). Only for routes in MEMBER_ROUTES
 * (lib/auth/member-routes.ts); run the handler's reads under
 * `withViewer('team', …)`.
 */
export async function getMemberOr401(): Promise<MemberCaller | NextResponse> {
  const res = await resolveLogin();
  if (!res) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // A member and nothing else: an admin gets admin-login, a client
  // client-login (client routes are their own list, never a member route).
  if (res.kind !== 'member') return loginRefused(res.kind);
  // A write made with an API key is always on the trail, whoever the key
  // acts as (audit item 5); a member's own session writes are not audited
  // here, as before.
  if (res.source === 'api') {
    const m = res.member;
    await auditMutation({
      id: m.anchorId,
      email: m.email,
      actor: { id: m.loginId, email: m.email, displayName: m.displayName, isOwner: false },
    });
  }
  return res.member;
}

/**
 * Is this member login still allowed in (audit S8)? For work that outlives
 * the request that authenticated it, such as an open realtime stream: the
 * row is re-read, so a deactivated login, a role change or members turned
 * off on the box all end it.
 */
export async function memberLoginActive(loginId: string): Promise<boolean> {
  const row = await loadLoginRow(loginId);
  return !!row && row.role === 'member' && loginUsable(row);
}

/** Is this admin login still allowed in? For a frame document that a
 *  seconds-lived ticket opened (an admin's test run of a member's app): the
 *  row is re-read, so a disabled or demoted login stops at once. */
export async function adminLoginActive(loginId: string): Promise<boolean> {
  const row = await loadLoginRow(loginId);
  return !!row && row.role === 'admin' && loginUsable(row);
}

/** When the calling request's session cookie expires (ms since epoch), or
 *  null without one. */
export async function sessionCookieExpiryMs(): Promise<number | null> {
  const c = (await cookies()).get(SESSION_COOKIE_NAME);
  const data = c ? verifySessionCookie(c.value) : null;
  return data ? data.exp * 1000 : null;
}

/** The calling login's own row, whatever its role: for the few routes about
 *  the login itself (change its password, sign out, who am I). Never for
 *  brain data. Each caller decides per role; a client is its own kind.
 *  `sessionEpoch` is the epoch the credential was verified at, for work that
 *  must still be that session's when it lands (OAuth consent). */
export async function getLoginOr401(): Promise<
  | {
      kind: 'admin';
      loginId: string;
      email: string;
      source: AuthSource;
      sessionEpoch: number;
      user: SessionUser;
    }
  | {
      kind: 'member';
      loginId: string;
      email: string;
      source: AuthSource;
      sessionEpoch: number;
      member: MemberCaller;
    }
  | {
      kind: 'client';
      loginId: string;
      email: string;
      source: AuthSource;
      sessionEpoch: number;
      client: ClientCaller;
    }
  | NextResponse
> {
  const res = await resolveLogin();
  if (!res) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  switch (res.kind) {
    case 'admin':
      return {
        kind: 'admin',
        loginId: res.user.actor.id,
        email: res.user.actor.email,
        source: res.source,
        sessionEpoch: res.epoch,
        user: res.user,
      };
    case 'member':
      return {
        kind: 'member',
        loginId: res.member.loginId,
        email: res.member.email,
        source: res.source,
        sessionEpoch: res.epoch,
        member: res.member,
      };
    case 'client':
      return {
        kind: 'client',
        loginId: res.client.loginId,
        email: res.client.email,
        source: res.source,
        sessionEpoch: res.epoch,
        client: res.client,
      };
  }
}

/**
 * The login POST /api/auth/sso turns into a session cookie (lib/owner-sso.ts):
 * an admin, audited as every admin call is, or a MEMBER. A member needs the
 * cookie for one thing a bearer cannot do: a top-level navigation to the MCP
 * consent page (GET /api/oauth/authorize) carries cookies only. A client is
 * refused: in a browser it signs in to a cookie already (client-link), and
 * its device token stays on its device. `epoch` is the epoch the credential
 * was just verified at, so the cookie is signed with that very session's.
 *
 * The DEVICE TOKEN only, never the cookie (access matrix T2): an upgrade
 * from the cookie alone would renew that cookie forever, with no device
 * behind it to revoke. `deviceJti` names the token, and the cookie is bound
 * to it.
 */
export async function getCookieUpgradeLoginOr401(): Promise<
  | { loginId: string; email: string; role: 'admin' | 'member'; epoch: number; deviceJti: string }
  | NextResponse
> {
  const bearer = await bearerLogin();
  if (!bearer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { resolved: res, jti: deviceJti } = bearer;
  switch (res.kind) {
    case 'admin':
      await auditMutation(res.user);
      return {
        loginId: res.user.actor.id,
        email: res.user.actor.email,
        role: 'admin',
        epoch: res.epoch,
        deviceJti,
      };
    case 'member':
      return {
        loginId: res.member.loginId,
        email: res.member.email,
        role: 'member',
        epoch: res.epoch,
        deviceJti,
      };
    case 'client':
      return loginRefused(res.kind);
  }
}

/**
 * A bcrypt hash (cost 12, same as every login) of a throwaway string. An
 * unknown email is compared against it, so a missing login costs the same
 * bcrypt time as a real one: the answer's timing does not say whether the
 * email has an account (F31).
 */
const DUMMY_HASH = '$2b$12$9jl0x3pjTchfqR4xdz2.b.iR/Ncv3n26E/ZAv4NPdmSPdYW.8YW3m';

/**
 * Verify email+password against auth.users. Returns the login id and its
 * session epoch (what a new cookie is signed with) on a match, null
 * otherwise. Pure DB-driven: no external auth service.
 */
export async function authenticatePassword(
  email: string,
  password: string,
): Promise<{ id: string; sessionEpoch: number } | null> {
  // Case-insensitive match — emails are case-insensitive in practice, and a
  // user who signed up "Jay@X.com" must be able to log in as "jay@x.com".
  // Handles any casing already stored (incl. legacy manually-inserted rows).
  const [row] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      hash: authUsers.passwordHash,
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
      sessionEpoch: authUsers.sessionEpoch,
    })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = lower(${email})`)
    .limit(1);
  // Always one bcrypt compare: a missing login is checked against the dummy
  // hash, so it answers no faster than a wrong password.
  const ok = await bcrypt.compare(password, row?.hash || DUMMY_HASH);
  if (!row?.hash) return null;
  // Check the password first, so a disabled login answers like a wrong one
  // (no account-state oracle), then refuse it.
  // Password sign-in is for admins and members only: a client signs in with a
  // link or a code (client logins C2), and a role this code does not know
  // never signs in. Refused like a wrong password (no role oracle).
  const role: string = row.role;
  const passwordRole = role === 'admin' || role === 'member';
  return ok && passwordRole && loginUsable(row)
    ? { id: row.id, sessionEpoch: row.sessionEpoch }
    : null;
}

/** authenticatePassword, the login id only (the password bearer logins: an
 *  admin's or a member's bearer is a mobile_tokens row and carries no epoch). */
export async function loginWithPassword(email: string, password: string): Promise<string | null> {
  return (await authenticatePassword(email, password))?.id ?? null;
}

/** The one password hash every login is stored with (bcrypt, cost 12). */
export function hashLoginPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/** Set the password-login session cookie for `loginId` on `res`: what
 *  POST /api/auth/login answers a good password with (the invite accept
 *  signs the new member in the same way). `epoch` is the login's
 *  session_epoch now. */
export function setSessionCookie(
  res: NextResponse,
  req: Request,
  loginId: string,
  epoch: number,
  opts: { ttlSeconds?: number } = {},
): void {
  const { value, maxAgeSec } = buildSessionCookie(loginId, { epoch, ttlSeconds: opts.ttlSeconds });
  res.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  });
}

/** Set the CLIENT session cookie for `loginId` on `res`: 30 days (plan
 *  section 4), signed with the login's session epoch now. Only the client
 *  sign-in routes call this. */
export function setClientSessionCookie(
  res: NextResponse,
  req: Request,
  loginId: string,
  epoch: number,
): void {
  const { value, maxAgeSec } = buildSessionCookie(loginId, {
    epoch,
    ttlSeconds: CLIENT_SESSION_TTL_SECONDS,
  });
  res.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  });
}

/** Update password hash. Caller is responsible for verifying the old password first. */
export async function updatePassword(userId: string, newPassword: string): Promise<void> {
  const hash = await hashLoginPassword(newPassword);
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

// ── Ending a login's sessions (F06) ──────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * End every session the login holds: bump auth.users.session_epoch, which
 * kills each cookie and `?at=` asset token signed with the old epoch on its
 * next request, revoke the login's bearers (mobile_tokens rows: the
 * mobile app and the web client), and delete its push devices. `keepJti` spares one bearer: the device
 * that asked (a password change made from the web client stays signed in).
 * Returns the new epoch, for a caller that re-issues its own cookie. Run it
 * inside the caller's transaction when there is one.
 */
export async function endLoginSessions(
  loginId: string,
  opts: {
    keepJti?: string | null;
    tx?: Tx;
    /** Filled with the routing tokens of the push devices this removed, for
     *  a caller that tells the relay after its transaction commits
     *  (forgetRelayDevices). */
    removedRoutingTokens?: string[];
    /** Also revoke every inbound API key of the login (migration 0232)
     *  and every OAuth grant it holds (its MCP connectors, admin ones
     *  included: M2 audit N4). For the deliberate security actions: a
     *  password change or reset, "sign out everywhere", an admin's End
     *  sessions, disable or role change (M2 audit F4), and a stolen device
     *  token presented again (N5). NOT a client's plain sign-out, which ends
     *  its sessions every time (M1 audit item 9). */
    endKeys?: boolean;
    /** Who ended them, for the keys' revoked_by (default: the login). */
    actorId?: string;
    /** With `tx`: filled with the ids of the keys this revoked, for the
     *  caller to audit (auditKeysEnded) once ITS transaction commits. */
    revokedKeyIds?: string[];
    /** Filled with the ids of the peers this unbound (access matrix L12),
     *  for the caller's answer. With `tx` the caller also audits them
     *  (auditPeersUnbound) once ITS transaction commits; without, this
     *  audits them after its own commit. */
    unboundPeerIds?: string[];
  } = {},
): Promise<number | null> {
  const ended: string[] = [];
  const unbound: string[] = [];
  const run = async (tx: Tx | typeof db) => {
    const [row] = await tx
      .update(authUsers)
      .set({ sessionEpoch: sql`${authUsers.sessionEpoch} + 1` })
      .where(eq(authUsers.id, loginId))
      .returning({ epoch: authUsers.sessionEpoch });
    if (!row) return null;
    await tx
      .update(mobileTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mobileTokens.userId, loginId),
          isNull(mobileTokens.revokedAt),
          ...(opts.keepJti ? [ne(mobileTokens.id, opts.keepJti)] : []),
        ),
      );
    // The login's push devices go with its tokens: a signed out phone gets
    // no more teasers. The devices a revoked token enrolled, and the ones
    // from before tokens were recorded (no token on the row: nothing says
    // which phone each is, so all go and the phone connects again). Only
    // the device of the token that is kept stays. A caller that passes
    // `removedRoutingTokens` tells the relay; else the relay keeps a device
    // nobody can address (the routing token lived only here).
    const removed = await tx
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.loginId, loginId),
          opts.keepJti
            ? or(isNull(pushSubscriptions.tokenId), ne(pushSubscriptions.tokenId, opts.keepJti))
            : undefined,
        ),
      )
      .returning({ routingToken: pushSubscriptions.routingToken });
    opts.removedRoutingTokens?.push(...removed.map((r) => r.routingToken));
    if (opts.endKeys) {
      const now = new Date();
      // The login's MCP connectors: every live OAuth grant and every code
      // not yet exchanged. An admin's grant has no session epoch, so only
      // this ends it (M2 audit N4). Under the login's OAuth lock, the one a
      // refresh and a code exchange take (final audit F3), so a grant minted
      // at the same moment is either seen here or refused there. The keys
      // under the lock a mint takes (audit LOW-6), for the same reason.
      await lockOauthActor(tx, loginId);
      await lockLoginKeys(tx, loginId);
      const keys = await tx
        .update(accessKeys)
        .set({ revokedAt: now, revokedBy: opts.actorId ?? loginId })
        .where(and(eq(accessKeys.loginId, loginId), isNull(accessKeys.revokedAt)))
        .returning({ id: accessKeys.id });
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthAccessTokens.actorId, loginId), isNull(oauthAccessTokens.revokedAt)));
      await tx.delete(oauthAuthCodes).where(eq(oauthAuthCodes.actorId, loginId));
      // And the peers that act as the login on /api/mcp (access matrix L12).
      unbound.push(...(await unbindPeersActingAs(loginId, tx)));
      ended.push(...keys.map((k) => k.id));
    }
    return row.epoch;
  };
  if (opts.tx) {
    const epoch = await run(opts.tx);
    opts.revokedKeyIds?.push(...ended);
    opts.unboundPeerIds?.push(...unbound);
    return epoch;
  }
  // Once more if it met a busy lock (last check F3): the caller has often
  // committed its first step already (a new password), and leaving the old
  // sessions alive after it must not happen silently. A second failure is
  // thrown: the request fails loudly (409 busy), never a quiet success.
  let epoch: number | null;
  try {
    epoch = await db.transaction((tx) => run(tx));
  } catch (err) {
    if (!isBusy(err) && pgErrorCode(err) !== '57014') throw err;
    ended.length = 0;
    unbound.length = 0;
    epoch = await db.transaction((tx) => run(tx));
  }
  // After the commit, so a rolled-back end leaves no row (final audit).
  auditKeysEnded(loginId, opts.actorId ?? loginId, ended);
  auditPeersUnbound(loginId, opts.actorId ?? loginId, unbound, 'sessions-ended');
  opts.unboundPeerIds?.push(...unbound);
  return epoch;
}

/** One key.revoked row for the keys a session end revoked (M2 audit N7):
 *  which login, how many, which. Call it after the revoking transaction
 *  commits. No row when there were none. */
export function auditKeysEnded(loginId: string, actorId: string, keyIds: readonly string[]): void {
  if (keyIds.length === 0) return;
  auditFireAndForget({
    actorId,
    actorEmail: 'session-end',
    action: 'key.revoked',
    detail: { loginId, count: keyIds.length, keyIds: [...keyIds], reason: 'sessions-ended' },
  });
}

// ── A rotated device token presented again (reuse detection) ────────────────

/** The successor a lost refresh answer may be answered with again. */
export type UnusedSuccessor = { id: string; userId: string; expiresAt: Date };

/**
 * A device token that a refresh replaced (`rotated_to` set) is presented
 * again. The app keeps only the newest token, so there are two cases, told
 * apart by the successor row:
 *
 *  - The successor has NEVER been used (no `last_used_at`, not rotated on,
 *    still live): the refresh answer was lost and the caller retries. Not a
 *    theft. `retry` hands the successor back, so the refresh route answers
 *    it again (the same jti, re-signed). Every other route answers 401.
 *  - The successor HAS been used: the presented token is a copy in other
 *    hands (or the holder kept a copy). That is the theft signal: end every
 *    session of the login, once, write `auth.token_reuse`, and mark the
 *    rotated row handled (`rotated_to` cleared), so every later presentation
 *    of it is a plain 401 and cannot end the login's sessions again.
 *
 * Anything else (the successor is gone, revoked unused, expired) is `dead`.
 * The claim on `rotated_to` is one statement, so two presentations at once
 * end the sessions once.
 */
export async function presentRotatedToken(
  tok: { jti: string; userId: string; rotatedTo: string },
  ctx: { method?: string; path: string; meta: { ip: string | null; userAgent: string | null } },
): Promise<{ kind: 'retry'; successor: UnusedSuccessor } | { kind: 'reuse' } | { kind: 'dead' }> {
  const [next] = await db
    .select({
      id: mobileTokens.id,
      userId: mobileTokens.userId,
      revokedAt: mobileTokens.revokedAt,
      rotatedTo: mobileTokens.rotatedTo,
      lastUsedAt: mobileTokens.lastUsedAt,
      expiresAt: mobileTokens.expiresAt,
    })
    .from(mobileTokens)
    .where(eq(mobileTokens.id, tok.rotatedTo))
    .limit(1);
  if (!next || next.userId !== tok.userId) return { kind: 'dead' };
  const used = next.lastUsedAt !== null || next.rotatedTo !== null;
  if (!used) {
    return !next.revokedAt && next.expiresAt.getTime() > Date.now()
      ? {
          kind: 'retry',
          successor: { id: next.id, userId: next.userId, expiresAt: next.expiresAt },
        }
      : { kind: 'dead' };
  }

  // A brain that refuses writes (a read-only database) cannot end anything:
  // the presentation is a plain 401 there, never a 500.
  let claimed: Array<{ id: string }>;
  try {
    claimed = await db
      .update(mobileTokens)
      .set({ rotatedTo: null })
      .where(and(eq(mobileTokens.id, tok.jti), eq(mobileTokens.rotatedTo, tok.rotatedTo)))
      .returning({ id: mobileTokens.id });
  } catch (err) {
    if (isWriteRefused(err)) return { kind: 'dead' };
    throw err;
  }
  if (claimed.length === 0) return { kind: 'dead' };

  const removedRoutingTokens: string[] = [];
  // A stolen token is the strongest theft signal there is: the login's API
  // keys and MCP connectors end with its sessions (M2 audit N5).
  await endLoginSessions(tok.userId, { removedRoutingTokens, endKeys: true });
  // Loaded here, not at the top: the session layer must not load the push
  // store (and its table columns) on every import.
  const { forgetRelayDevices } = await import('../push/store');
  await forgetRelayDevices(removedRoutingTokens);
  const [login] = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, tok.userId))
    .limit(1);
  auditFireAndForget({
    actorId: tok.userId,
    actorEmail: login?.email ?? '',
    action: 'auth.token_reuse',
    method: ctx.method || 'POST',
    path: ctx.path || '/api/auth/token/refresh',
    detail: {
      deviceId: tok.jti,
      successor: tok.rotatedTo,
      reason: 'rotated-token-presented-again',
    },
    ...ctx.meta,
  });
  return { kind: 'reuse' };
}

/** The login's session epoch now (0 for an unknown login: whatever is minted
 *  with it fails the row check anyway). */
export async function loginSessionEpoch(loginId: string): Promise<number> {
  return (await loadLoginRow(loginId))?.sessionEpoch ?? 0;
}

/** An `?at=` asset token for the anchor's bytes, minted for the login
 *  `loginId` and signed with that login's current session epoch. `ttlSeconds`
 *  shortens it (the client shell's: CLIENT_ASSET_TOKEN_TTL_SECONDS). */
export async function mintAssetToken(
  anchorId: string,
  loginId: string,
  opts: { ttlSeconds?: number } = {},
): Promise<string> {
  return buildAssetToken(anchorId, loginId, await loginSessionEpoch(loginId), opts.ttlSeconds);
}
