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
  mayEditSql,
  mayManageSql,
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
  currentRequestOutcome,
  enterRequestScope,
  hasRequestSlot,
  loginScopeFor,
  createHomeIntent,
  withViewer,
  noteRequestSystem,
  noteRequestCreateHome,
  noteRequestOwnRule,
  setRequestActor,
  loginActor,
  currentCaller,
  type AdminView,
  type CreateHome,
  type GateCaller,
  type RequestScopeMode,
} from '@mantle/db';
import { AccessError, mapAccessError, UUID_RE } from '@mantle/std';
import {
  loadAnchorId,
  loadBearerToken,
  loadLoginRow,
  touchBearerToken,
  type LoginRow,
} from './login-row';
import {
  isDetachedDev,
  isAuditSelfLogged,
  isRenderAssetPath,
  MANTLE_PATH_HEADER,
  MANTLE_METHOD_HEADER,
  RENDER_COOKIE_NAME,
  secureCookies,
} from '../auth-constants';
import { auditFireAndForget, requestMeta } from '../audit';
import { lockOauthActor } from '../oauth-lock';
import { auditPeersUnbound, unbindPeersActingAs } from '../peer-unbind';
import { isAccessKey, lockLoginKeys } from '../access-keys';
import { getRequestContext } from '../../server/request-context';
import { itemNotFound, itemRefused } from './item-answers';
import { bearerFromHeader } from './request';
import {
  anyLoginRow,
  FRAME_ROWS,
  assetQueryAsHanded,
  currentRoute,
  keyOnRow,
  memberOpenRead,
  memberOpenWrite,
  routeItemTarget,
  type RouteCaller,
  type RouteRow,
} from './route-policy';
import { auditsAsWrite } from './route-scope';
import type { Login } from './login';
import { takeRouteLimits, type LimitLogin } from '../route-limits';
import {
  SESSION_COOKIE_NAME,
  buildAssetToken,
  buildSessionCookie,
  decodeUnverifiedClaims,
  verifyAppFrameTicket,
  verifyAssetToken,
  verifyMobileToken,
  verifyRenderToken,
  verifySessionCookie,
  type AppFrameTicket,
} from './tokens';
import { env } from '@mantle/config';
import { isLoginRole, type LoginRole } from '@mantle/client-types/role-names';

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
 * `ownerCaller().id` call sites keep querying the one brain no matter who is
 * logged in. `email` is the ACTOR's (display + audit surfaces). Anything
 * login-personal (own password, audit attribution) must use `actor.id`.
 * A transition adapter: the owner routes' caller until they read the Login
 * (./login.ts: `brainId` and `actor`) and adminFacts().
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
 * read at the team level through RLS (`withViewer(…)`). A transition
 * adapter as SessionUser is: the member routes' caller until they read the
 * Login.
 */
export type MemberCaller = {
  role: 'member';
  /** The login row (auth.users.id): own password, own thread, audit. */
  loginId: string;
  /** The brain the member belongs to (the anchor's id). */
  anchorId: string;
  email: string;
  displayName: string | null;
  contactId: string | null;
};

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

/**
 * Whether a login row is an Admin login: role admin AND a user of the
 * brain's live Admin workspace now (adminMember, mantle_login_is_admin read
 * with the row). The role alone never makes one: a role=member login inside
 * Admin stays a member, and a role=admin login outside Admin is no Admin
 * login (no asset token, render cookie or frame; its areas come from the
 * area rule, so none). The session itself (resolvedFor),
 * memberLoginActive and findMemberAsset still read the role.
 */
function adminLogin(row: Pick<LoginRow, 'role' | 'adminMember'>): boolean {
  return row.role === 'admin' && row.adminMember === true;
}

/** Who is calling, resolved from the login row: an admin (today's
 *  SessionUser) or a member. `epoch`: the login's session epoch on the row
 *  the credential was just checked against. A login carries no permission
 *  of its own (workspaces W8a): what it reads and may do is its workspaces'. */
type Resolved =
  | {
      kind: 'admin';
      loginId: string;
      user: SessionUser;
      source: AuthSource;
      epoch: number;
      contactId: string | null;
      /** adminLogin(row): role admin AND a user of Admin now. */
      adminPair: boolean;
    }
  | {
      kind: 'member';
      loginId: string;
      member: MemberCaller;
      source: AuthSource;
      epoch: number;
      adminPair: false;
    };

/**
 * Owner gate for the byte-serving asset routes only. Resolves the session
 * (cookie/bearer) first; failing that, accepts a valid `?at=` asset token in the
 * URL — the one place a browser-native `src` can convey auth. Owner-scoped: the
 * route still scopes the lookup to the returned id, so a token for user X only
 * reaches X's bytes. Returns a 401 JSON `Response` like the owner guard.
 */
export async function getOwnerForAsset(req: Request): Promise<SessionUser | NextResponse> {
  const user = await ownerForAsset(req);
  if (user instanceof NextResponse) return user;
  // The bytes of an item are a read of that item: the Admin user's scope
  // (W6a), as on the other owner routes (a render cookie acts for the admin
  // who asked for the print).
  const refused = await adminRouteGate(user.actor.id);
  return refused ?? user;
}

async function ownerForAsset(req: Request): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  if (user) return user;
  const at = new URL(req.url).searchParams.get('at');
  if (at) {
    const asset = await requestLogins().ownerAsset(req.url);
    if (asset === 'refused') return accessRefusal(new AccessError('unauthorized'));
    if (asset) return asset;
  }
  // The browser sidecar rendering an export: the render cookie, on the byte
  // routes a render surface loads (page images, scene images, embedded
  // drawings) and nowhere else. The admin private-space bytes are not among
  // them, so a printed page can never pull a private item.
  if (req.method === 'GET' && isRenderAssetPath(new URL(req.url).pathname)) {
    const render = await renderCaller();
    if (render) return render.user;
  }
  return accessRefusal(new AccessError('unauthorized'));
}

/**
 * The admin an `?at=` asset token in `url` names (findOwnerAsset), with no
 * effect: null when the URL carries no valid token, 'refused' when its
 * login may not use it.
 *
 * The signature proves the server minted this for `uid`; the route scopes
 * to it. Byte-serving is GET-only, so the synthetic actor never reaches the
 * mutation/audit choke point. `act` names the LOGIN the token was minted
 * for, so per-login asset routes (the profile photo) can address that row;
 * absent, the actor is the anchor itself (the pre-claim behavior).
 */
async function findOwnerAsset(url: string): Promise<SessionUser | 'refused' | null> {
  const at = new URL(url).searchParams.get('at');
  const claims = at ? verifyAssetToken(at) : null;
  if (!claims) return null;
  // The login the token was minted for (`act`, else the anchor itself)
  // must still be a usable Admin login (adminLogin) on the same session
  // epoch. Members are never minted one; this closes a revoked, demoted,
  // removed from Admin or signed-out login's 2-hour window too.
  const row = await loadLoginRow(claims.act ?? claims.uid);
  if (!row || !adminLogin(row) || !loginUsable(row) || row.sessionEpoch !== claims.ep) {
    return 'refused';
  }
  return {
    id: claims.uid,
    email: '',
    actor: { id: claims.act ?? claims.uid, email: '', displayName: null, isOwner: false },
  };
}

/** The admin a render cookie names and the node it may open
 *  (findRender), the request's actor named after it. */
async function renderCaller(): Promise<{ user: SessionUser; nodeId: string } | null> {
  const found = await requestLogins().render();
  // Arch A2a: the render runs as the login the cookie names.
  if (found) setRequestActor(loginActor(found.user.actor.id, 'rw'));
  return found;
}

/**
 * The admin a render cookie (kind 'r', lib/auth/tokens.ts) was minted for,
 * and the node it may open, with no effect. The login is re-read: a
 * disabled or demoted login's cookie stops at once, and a cookie naming
 * another brain's anchor never matches. Null when the request carries no
 * valid render cookie.
 */
async function findRender(): Promise<{ user: SessionUser; nodeId: string } | null> {
  const value = (await cookies()).get(RENDER_COOKIE_NAME)?.value;
  const claims = value ? verifyRenderToken(value) : null;
  if (!claims) return null;
  const row = await loadLoginRow(claims.act);
  if (!row || !adminLogin(row) || !loginUsable(row)) return null;
  const user = await sessionUserFor(row);
  if (!user || user.id !== claims.uid) return null;
  return { user, nodeId: claims.n };
}

/**
 * The byte routes of brain items for EVERY login (W7e): an Admin user as
 * getOwnerForAsset (its session, an asset token, the render cookie; `member`
 * null); a member by its session or a member `?at=` token (an <img> src
 * carries no bearer), on a route open to it (memberMayRead), in its own
 * request scope (`member` set). An item the login does not read is the
 * route's own 404.
 */
export async function getReaderForAsset(req: Request): Promise<AssetReader | NextResponse> {
  const owner = await getOwnerForAsset(req);
  if (!(owner instanceof NextResponse)) return { user: owner, member: null };
  if (owner.status !== 401) return owner;
  const member = await memberForAsset(req);
  if (member instanceof NextResponse) return owner;
  const route = guardRoute();
  if (route === UNROUTED) return unroutedRefusal();
  if (route === OUTSIDE || !memberOpenRead(route)) return loginRefused('member');
  await enterLoginScope(member.loginId, requestMode(true));
  return {
    user: {
      id: member.anchorId,
      email: member.email,
      actor: {
        id: member.loginId,
        email: member.email,
        displayName: member.displayName,
        isOwner: false,
      },
    },
    member,
  };
}

/**
 * Where a member route's handler runs (W7e): a route that reads brain items
 * (route-scope.ts classes /api/member as 'content') runs in the login's
 * request scope, as an owner route a member may read does; only the login's
 * own things ('self': the home pin, its MCP clients, push devices, the live
 * stream) still hold their own rule ('own-rule', their reads about the
 * login itself). Outside a request slot nothing changes; a request slot
 * with no row is refused (guardRoute). Returns the refusal, or null.
 */
async function memberRouteScope(loginId: string): Promise<NextResponse | null> {
  const route = guardRoute();
  if (route === UNROUTED) return unroutedRefusal();
  if (route === OUTSIDE || route.scope?.kind === 'self') {
    noteRequestOwnRule(loginId);
    return null;
  }
  await enterLoginScope(loginId, requestMode(true));
  return null;
}

async function memberForAsset(req: Request): Promise<MemberCaller | NextResponse> {
  const res = await resolveLogin();
  if (res?.kind === 'member') return res.member;
  const member = await requestLogins().memberAsset(req.url);
  return member ?? accessRefusal(new AccessError('unauthorized'));
}

/** The member an `?at=` asset token in `url` was minted for (the member
 *  shell mints it with `act` = the login), with no effect, or null. The
 *  login is re-read, so a disabled or demoted login's token stops at once. */
async function findMemberAsset(url: string): Promise<MemberCaller | null> {
  const at = new URL(url).searchParams.get('at');
  const claims = at ? verifyAssetToken(at) : null;
  if (!claims?.act) return null;
  const row = await loadLoginRow(claims.act);
  if (!row || row.role !== 'member' || !loginUsable(row) || row.sessionEpoch !== claims.ep) {
    return null;
  }
  const resolved = await resolvedFor(row, 'web');
  return resolved?.kind === 'member' && resolved.member.anchorId === claims.uid
    ? resolved.member
    : null;
}

/** A device token a refresh replaced, presented again (reuse detection). */
type RotatedToken = { jti: string; userId: string; rotatedTo: string };

/** What a device token (`Authorization: Bearer <mobile-token>`) resolves
 *  to (findBearer), with no effect: the login and the token's id, the
 *  token to stamp as used, a rotated token presented again. */
type FoundBearer = Readonly<{
  resolved: Resolved | null;
  jti: string | null;
  touch: string | null;
  rotated: RotatedToken | null;
}>;

const NO_BEARER: FoundBearer = Object.freeze({
  resolved: null,
  jti: null,
  touch: null,
  rotated: null,
});

/**
 * Resolve the login from an `Authorization: Bearer <mobile-token>` header,
 * with no effect: verify the signature, confirm the row is
 * present/unrevoked/unexpired and names the same login. applyBearer then
 * stamps the token as used, or runs the reuse check of a rotated one.
 *
 * A token that carries a session epoch (`ep`) is also held to it: once the
 * login's epoch moves on (sign out, End sessions, disable, a role change)
 * the token is dead, as a cookie is.
 */
async function findBearer(): Promise<FoundBearer> {
  const token = bearerFromHeader((await headers()).get('authorization'));
  if (!token) return NO_BEARER;
  const claims = verifyMobileToken(token);
  if (!claims) return NO_BEARER;

  const tok = await loadBearerToken(claims.jti);
  if (!tok || tok.userId !== claims.uid) return NO_BEARER;
  if (tok.revokedAt) {
    // A token a refresh replaced, presented on an ordinary route: when its
    // successor has been used, this is the stolen-from copy (the app holds
    // only the newest), on whatever route it shows up (applyBearer).
    return tok.rotatedTo
      ? { ...NO_BEARER, rotated: { jti: claims.jti, userId: tok.userId, rotatedTo: tok.rotatedTo } }
      : NO_BEARER;
  }
  if (tok.expiresAt.getTime() <= Date.now()) return NO_BEARER;

  const row = await loadLoginRow(claims.uid);
  if (!row || !loginUsable(row)) return NO_BEARER;
  if (claims.ep !== undefined && claims.ep !== row.sessionEpoch) return NO_BEARER;

  const resolved = await resolvedFor(row, 'mobile');
  return { resolved, jti: resolved ? claims.jti : null, touch: claims.jti, rotated: null };
}

/** The effects of a found device token, each time a guard reads it: the
 *  reuse check of a rotated token (which may end the login's sessions), or
 *  the last_used_at stamp. */
async function applyBearerEffects(found: {
  touch: string | null;
  rotated: RotatedToken | null;
}): Promise<void> {
  if (found.rotated) {
    const h = await headers();
    await presentRotatedToken(found.rotated, {
      method: (h.get(MANTLE_METHOD_HEADER) ?? '').toUpperCase(),
      path: h.get(MANTLE_PATH_HEADER) ?? '',
      meta: await requestMeta(),
    });
  }
  if (found.touch) await touchBearerToken(found.touch);
}

/** The device token's login and its id (the cookie upgrade binds the
 *  cookie it mints to it), its effects applied. */
async function bearerLogin(): Promise<{ resolved: Resolved; jti: string } | null> {
  const found = await requestLogins().bearer();
  await applyBearerEffects(found);
  return found.resolved && found.jti ? { resolved: found.resolved, jti: found.jti } : null;
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
 * MemberCaller. Every role is named: a role this code does not know is NO
 * login (null), never an admin (client logins C0: before it, every role that
 * was not member resolved as an admin). A row still marked client (none is
 * left after migration 0272, workspaces W8a) is no login either. Null too
 * when the brain has no anchor (a corrupt state). The session stays on the
 * role: a role=admin login outside Admin keeps its session and works in its
 * own scope, but is no Admin (adminLogin: no asset token, render cookie or
 * frame, no area).
 */
async function resolvedFor(row: LoginRow, source: AuthSource): Promise<Resolved | null> {
  const role: string = row.role;
  switch (role) {
    case 'admin': {
      const user = await sessionUserFor(row);
      if (!user) return null;
      return {
        kind: 'admin',
        loginId: row.id,
        user,
        source,
        epoch: row.sessionEpoch,
        contactId: row.contactId,
        adminPair: adminLogin(row),
      };
    }
    case 'member': {
      const anchorId = await getAnchorId();
      if (!anchorId) return null;
      return {
        kind: 'member',
        loginId: row.id,
        source,
        epoch: row.sessionEpoch,
        adminPair: false,
        member: {
          role: 'member',
          loginId: row.id,
          anchorId,
          email: row.email,
          displayName: row.displayName,
          contactId: row.contactId,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * The login an inbound API key (`mtlk_`) acts as, found with no effect.
 * `undefined` when the request carries no key; no login when it carries one
 * that is not let in.
 *
 * A key is taken ONLY from the request context, where the gate leaves it
 * after every check passed (server/middleware/access-key-gate.ts: the
 * failed-try budget, the key itself, its rate budget, its scope). It is
 * never verified again here (audit item 3): a request that reached a route
 * without the gate's grant (a public prefix such as /api/auth, or a path
 * shape the gate lets through) has no key login at all.
 *
 * The scope guard runs again here (audit item 1), on the request's
 * ROUTE_POLICY row (keyOnRow, the one judgment of a key on a row, the
 * gate's own), so a `source: 'api'` login exists only for a /api/v1 route
 * the key may call: the route's area, and a write only for a read_write
 * key. Every gate below (getOwnerOr401WithLogin, getMemberOr401, getLoginOr401)
 * resolves through this, so none can hand a read key a write route. On a
 * routed request the gate finds it once (resolveHttpLogin), on the row it
 * judged the key on.
 */
async function findKeyLogin(): Promise<FoundLogin | undefined> {
  const h = await headers();
  const token = bearerFromHeader(h.get('authorization'));
  if (!isAccessKey(token)) return undefined;
  const ctx = getRequestContext();
  const grant = ctx?.accessKey;
  if (!ctx || !grant || !keyOnRow(grant, currentRoute(), ctx.path).ok) return NO_LOGIN;
  const resolved = await resolvedFor(grant.login, 'api');
  // Arch A2a: a read key's request runs as login(ro).
  return { ...NO_LOGIN, resolved, mode: grant.access === 'read_write' ? 'rw' : 'ro' };
}

/** Name the request's actor (arch A2a, plan 4.1): the login the guard
 *  resolved, read-write unless a read key. The guard's later notes keep it
 *  (an Admin write) or replace it (an area route: system). */
function nameRequestLogin(res: Resolved, mode: 'rw' | 'ro'): void {
  setRequestActor(loginActor(res.loginId, mode));
}

/**
 * What a request's login credential resolves to (findLogin), with no
 * effect: the login, the mode the guard names its actor in (null: it names
 * none, the detached-dev login), and the device token's effects
 * (applyBearerEffects).
 */
type FoundLogin = Readonly<{
  resolved: Resolved | null;
  mode: 'rw' | 'ro' | null;
  touch: string | null;
  rotated: RotatedToken | null;
}>;

const NO_LOGIN: FoundLogin = Object.freeze({
  resolved: null,
  mode: null,
  touch: null,
  rotated: null,
});

/** Find the calling login, admin or member, cookie first then bearer, with
 *  no effect (applyLogin applies them). `bearer` finds the device token. */
async function findLogin(bearer: () => Promise<FoundBearer>): Promise<FoundLogin> {
  // DB-less dev: a detached frontend has no local Postgres, so the configured
  // remote identity stands in for the cookie→authUsers lookup. Always an
  // admin. No-op in prod.
  const dev = detachedDevUser();
  if (dev) {
    const resolved: Resolved = {
      kind: 'admin',
      loginId: dev.actor.id,
      user: dev,
      source: 'web',
      epoch: 0,
      contactId: null,
      adminPair: true,
    };
    return { ...NO_LOGIN, resolved };
  }

  // An API key is judged on itself, never with the cookie: a key presented
  // where keys are not accepted is no login at all.
  const key = await findKeyLogin();
  if (key !== undefined) return key;

  const c = (await cookies()).get(SESSION_COOKIE_NAME);
  if (c) {
    const data = verifySessionCookie(c.value);
    if (data) {
      const row = await loadLoginRow(data.uid);
      // The epoch check is what ends a cookie: a password change, a disable,
      // a role change or "sign out everywhere" bumps the row (F06).
      // A cookie the bearer upgrade minted lives only while its device does.
      const deviceOk = !data.dj || (await cookieDeviceAlive(data.dj, data.uid));
      if (row && loginUsable(row) && row.sessionEpoch === data.ep && deviceOk) {
        const resolved = await resolvedFor(row, 'web');
        if (resolved) return { ...NO_LOGIN, resolved, mode: 'rw' };
      }
    }
  }
  // Mobile companion: Authorization: Bearer <mobile-token>.
  const found = await bearer();
  return {
    resolved: found.resolved,
    mode: found.resolved ? 'rw' : null,
    touch: found.touch,
    rotated: found.rotated,
  };
}

/** A found login's effects, each time a guard reads it (as each guard call
 *  resolved the login before A4 step 3a): the device token's, then the
 *  request's actor named. */
async function applyLogin(found: FoundLogin): Promise<Resolved | null> {
  await applyBearerEffects(found);
  if (found.resolved && found.mode) nameRequestLogin(found.resolved, found.mode);
  return found.resolved;
}

/** Resolve the calling login, admin or member, cookie first then bearer:
 *  the request's login (the gate found it once, A4 step 3a), its effects
 *  applied. */
async function resolveLogin(): Promise<Resolved | null> {
  const logins = requestLogins();
  const found = await logins.login();
  // The gate applied this login's effects before its Admin step
  // (enterRouteLogin, A4 step 3b part 4): the first read takes them as
  // applied, so the device token is stamped once, as before.
  if (logins.takeApplied(found)) return found.resolved;
  return applyLogin(found);
}

// ── The request's logins, found once (arch A4 step 3a) ──────────────────────

/**
 * Keep `p` until it fails: a failed find is asked again next time. `drop`
 * gets the failed promise and clears its slot only while the slot still
 * holds that one (A4 step 3a re-audit L-c): a find the request forgot
 * (forget) and replaced with a fresh one may fail after the fresh one is
 * stored, and must not clear it.
 */
function keepUntilFailed<T>(p: Promise<T>, drop: (failed: Promise<T>) => void): Promise<T> {
  p.catch(() => drop(p));
  return p;
}

/**
 * Every credential a request carries, each found once and kept for the
 * request: the login (findLogin: a key, the session cookie, a device
 * token), the device token on its own (the cookie upgrade), an `?at=`
 * asset token (admin or member) and the render cookie. Finding has no
 * effect; each guard read applies the effects it applied before (applyLogin,
 * applyBearerEffects, renderCaller), so a guard answers as it did when it
 * resolved the login itself. A failed find is not kept: the next read asks
 * again, as a guard did.
 *
 * The gate makes one for each routed request and binds it on the caller
 * (resolveHttpLogin); requestLogins() reads it. Outside a routed request
 * (a test calling a handler, a script) each read makes a fresh one: the
 * guards resolve as before.
 */
export class RequestLogins {
  #login: Promise<FoundLogin> | null = null;
  #bearer: Promise<FoundBearer> | null = null;
  #render: Promise<{ user: SessionUser; nodeId: string } | null> | null = null;
  readonly #owner = new Map<string, Promise<SessionUser | 'refused' | null>>();
  readonly #member = new Map<string, Promise<MemberCaller | null>>();
  #changed = false;
  /** The gate's failed find, kept for the first guard read (keepFailure). */
  #failure: Promise<FoundLogin> | null = null;
  /** The guard's answer the pipeline gave before the handler
   *  (answerRouteCaller, A4 step 3b), which the row's reader reads
   *  (ownerCaller(), memberCaller(), loginCaller(), chatLoginCaller()). */
  #answered: PipelineAnswer | null = null;
  /** The found login whose effects the gate applied before its Admin step
   *  (enterRouteLogin, A4 step 3b part 4), until a read takes them. */
  #applied: FoundLogin | null = null;

  /** Whether the request changed a login since the gate resolved it
   *  (forget): the gate's Admin view of the row's area is then not read. */
  get changed(): boolean {
    return this.#changed;
  }

  /** Drop every login found so far (A4 step 3a audit L1): the request
   *  ended a login's sessions or changed its role or switch, so the next
   *  guard read finds each credential afresh, as every guard call did
   *  before step 3a. Already-applied effects stay applied. */
  forget(): void {
    this.#login = null;
    this.#bearer = null;
    this.#render = null;
    this.#owner.clear();
    this.#member.clear();
    this.#failure = null;
    this.#applied = null;
    this.#changed = true;
  }

  /** The gate's find of the login failed (the database, A4 step 3a audit
   *  L4): the first guard read is answered with that failure instead of
   *  asking again, so a request looks the login up once, as each guard
   *  call did before step 3a. A read after that one asks again. */
  keepFailure(failed: Promise<FoundLogin>): void {
    this.#failure = failed;
  }

  /** The gate applied `found`'s effects (enterRouteLogin): the first read
   *  of it takes them as applied (takeApplied). */
  markApplied(found: FoundLogin): void {
    this.#applied = found;
  }

  /** Whether the gate applied `found`'s effects and no read took them
   *  yet; the first read takes them, a later one applies them again, as
   *  each guard read did. */
  takeApplied(found: FoundLogin): boolean {
    if (this.#applied === null || this.#applied !== found) return false;
    this.#applied = null;
    return true;
  }

  /** Keep the guard's answer the pipeline gave (answerRouteCaller). It is
   *  the request's answer, given once before the handler: forget does not
   *  drop it (a handler reads it at its start). */
  keepAnswer(answer: PipelineAnswer): void {
    this.#answered = answer;
  }

  /** The guard's answer the pipeline gave, or null. */
  get answer(): PipelineAnswer | null {
    return this.#answered;
  }

  login(): Promise<FoundLogin> {
    const failed = this.#failure;
    if (failed) {
      this.#failure = null;
      return failed;
    }
    return (this.#login ??= keepUntilFailed(
      findLogin(() => this.bearer()),
      (failed) => {
        if (this.#login === failed) this.#login = null;
      },
    ));
  }

  bearer(): Promise<FoundBearer> {
    return (this.#bearer ??= keepUntilFailed(findBearer(), (failed) => {
      if (this.#bearer === failed) this.#bearer = null;
    }));
  }

  render(): Promise<{ user: SessionUser; nodeId: string } | null> {
    return (this.#render ??= keepUntilFailed(findRender(), (failed) => {
      if (this.#render === failed) this.#render = null;
    }));
  }

  ownerAsset(url: string): Promise<SessionUser | 'refused' | null> {
    return RequestLogins.#kept(this.#owner, url, findOwnerAsset);
  }

  memberAsset(url: string): Promise<MemberCaller | null> {
    return RequestLogins.#kept(this.#member, url, findMemberAsset);
  }

  static #kept<T>(map: Map<string, Promise<T>>, url: string, find: (url: string) => Promise<T>) {
    let p = map.get(url);
    if (!p) {
      p = keepUntilFailed(find(url), (failed) => {
        if (map.get(url) === failed) map.delete(url);
      });
      map.set(url, p);
    }
    return p;
  }
}

/** The key the gate binds the request's logins under, in the caller's
 *  facts. */
const HTTP_LOGINS = 'httpLogins';
/** The key of the Admin view of the row's area the gate resolved for the
 *  login (resolveHttpLogin), in the caller's facts. */
const HTTP_ADMIN = 'httpAdmin';

/** The request's logins, as the gate bound them on the caller; a fresh set
 *  outside a routed request (and inside a call nested in one with a caller
 *  of its own), where the guards resolve as before. */
function requestLogins(): RequestLogins {
  return boundLogins(currentCaller()) ?? new RequestLogins();
}

/**
 * The request changed a login (A4 step 3a audit L1): its sessions ended
 * (endLoginSessions), its role or disabled switch changed (updateLogin), or
 * a key or device token it may have come in on was revoked. The request's
 * logins forget what they found, so a later guard read in the same request,
 * or work it started and did not await, finds the login afresh and sees the
 * change, as each guard call did when it looked the login up itself. Any
 * login, not only the request's own: finding again is what a guard did
 * before, and costs one read on these rare paths. A revoked key is the
 * exception, as on main: findKeyLogin reads the gate's grant and never
 * checks the key again, so the login a key resolved to is found again for
 * the rest of the request. No-op outside a routed request.
 */
export function forgetRequestLogins(): void {
  boundLogins(currentCaller())?.forget();
}

/**
 * The rows whose handler reads no login: the sandbox frame documents
 * (route-policy.ts FRAME_ROWS), opened by the `?t=` frame ticket the gate
 * admitted (their caller is the ticket, frameTicketCaller(); the route
 * reads the login it names). The gate finds no login for them (A4 step 3a
 * audit L4): nothing would read it.
 */
const NO_LOGIN_LOOKUP_ROWS: ReadonlySet<string> = FRAME_ROWS;

/** The logins bound on `caller` by the gate, or null. */
function boundLogins(caller: GateCaller | null): RequestLogins | null {
  const bound = caller?.facts?.[HTTP_LOGINS];
  return bound instanceof RequestLogins ? bound : null;
}

/** What the gate binds on a routed request's caller (resolveHttpLogin). */
export type HttpLogin = Readonly<{
  logins: RequestLogins;
  /** The login the request's credential resolved to, when the gate judged
   *  one and it resolved; else null (a public row: its guard finds the
   *  login on first read). */
  loginId: string | null;
  role: LoginRole | null;
  /** The mode its actor is named in (a read key: ro). */
  mode: 'rw' | 'ro' | null;
  /** What the login holds of the row's Admin area (the Admin step's
   *  answer: the gate's step 5 on a row whose handler reads the pipeline's
   *  caller, else read by adminRouteGate), for an Admin login on a row
   *  that manages an area; else null (the guard asks requireArea itself). */
  admin: AdminView | null;
  /** The facts the caller carries: the logins and the Admin view, under
   *  their keys. */
  facts: Readonly<Record<string, unknown>>;
}>;

/**
 * The gate's step 1 for a routed request (arch A4 step 3a): the request's
 * logins, and, where the gate judged a credential (a row that is not
 * public), the login found once now, with what it holds of the row's Admin
 * area. The same functions the guards read, so the two cannot drift. A
 * public row judges its own credential: its login is found on the first
 * guard read, once. A frame document's row finds none (its handler reads
 * no guard). A find that fails (the database) is not kept: the first guard
 * read answers with that failure, a later one asks again.
 */
export async function resolveHttpLogin(row: RouteRow): Promise<HttpLogin> {
  const logins = new RequestLogins();
  const none = {
    logins,
    loginId: null,
    role: null,
    mode: null,
    admin: null,
    facts: Object.freeze({ [HTTP_LOGINS]: logins }),
  } as const;
  if (row.public || NO_LOGIN_LOOKUP_ROWS.has(row.pattern)) return none;
  let found: FoundLogin;
  const finding = logins.login();
  try {
    found = await finding;
  } catch {
    // The guard's first read answers with this failure (keepFailure).
    logins.keepFailure(finding);
    return none;
  }
  const res = found.resolved;
  if (!res) return none;
  const loginId = res.loginId;
  let admin: AdminView | null = null;
  // The Admin step's answer for an Admin login on a row that manages an
  // area: requireArea's, as adminRouteGate asked it. The view holds the
  // row's area or nothing; a login without it is refused ('area', whether
  // or not it is in the Admin workspace: the guard's rule): by the gate's
  // step 5 on a row whose handler reads the pipeline's caller (A4 step 3b
  // part 4, httpCaller), by adminRouteGate on the others.
  if (row.area && res.kind === 'admin') {
    try {
      const holds = await loginHoldsArea(loginId, row.area);
      admin = { holdsAdmin: true, areas: new Set(holds ? [row.area] : []) };
    } catch {
      admin = null;
    }
  }
  return {
    logins,
    loginId,
    role: res.kind,
    mode: found.mode,
    admin,
    facts: Object.freeze({ [HTTP_LOGINS]: logins, ...(admin ? { [HTTP_ADMIN]: admin } : {}) }),
  };
}

// ── The caller the pipeline answers (arch A4 step 3b) ───────────────────────

/**
 * The login's effects failed before the gate's Admin step (enterRouteLogin:
 * the database, stamping a device token). Thrown out of enterCall for the
 * gate middleware, which answers the error it carries in the handler's
 * place, where the owner guard threw it before (onError, with the gate's
 * CORS headers).
 */
export class RouteLoginError extends Error {
  constructor(readonly error: unknown) {
    super('the request login could not be applied');
    this.name = 'RouteLoginError';
  }
}

/**
 * The gate's step before its Admin step (A4 step 3b part 4), on a row
 * whose handler reads the pipeline's caller and whose Admin step the gate
 * enforces (an Admin login on an area row: the HTTP caller's `admin`): the
 * login's effects applied in the request slot, before step 5 refuses or
 * lets it through, as the owner guard applied them before its area check:
 * a device token's stamp, the login named as the request's actor. The
 * answer the pipeline gives next (answerRouteCaller) takes them as applied,
 * so nothing is done twice. Runs `fn` (the gate's steps 4 to 7) after.
 */
export async function enterRouteLogin<T>(fn: () => Promise<T>): Promise<T> {
  // The login's effects are applied here, before the gate's steps 4 and 5:
  // a pre-run check or narrower on such a row must read the bound caller
  // (currentCaller(), its facts), never a session guard.
  try {
    // Inside the wrap, so even this failure is answered in the handler's
    // place with the gate's CORS headers (RouteLoginError).
    const logins = boundLogins(currentCaller());
    if (!logins) throw new Error('enterRouteLogin: the request has no logins bound');
    const found = await logins.login();
    await applyLogin(found);
    // TODO(A4 exit): the markApplied/takeApplied handshake folds into the
    // gate when the last guard goes (the gate applies the effects, once).
    logins.markApplied(found);
  } catch (error) {
    throw new RouteLoginError(error);
  }
  return fn();
}

/**
 * The guard's answer the pipeline gave for a row, by the row's caller kind
 * (RouteRow.caller): what that kind's guard answers when it lets a login
 * through. Kept on the request's logins for the row's reader. A kind
 * answered at the read (route-policy.ts ANSWERED_AT_READ) keeps the answer
 * to take (AtRead), run by the handler's first read.
 */
type PipelineAnswer =
  | Readonly<{ caller: 'owner'; owner: OwnerRouteLogin }>
  | Readonly<{ caller: 'member'; member: MemberCaller }>
  | Readonly<{ caller: 'login'; login: Login }>
  | Readonly<{ caller: 'chat'; chat: ChatLogin }>
  | Readonly<{ caller: 'session'; user: SessionUser | null }>
  | Readonly<{ caller: 'ownerAsset'; user: SessionUser }>
  | Readonly<{ caller: 'readerAsset'; reader: AssetReader }>
  | Readonly<{ caller: 'frame'; ticket: AppFrameTicket | null }>
  | Readonly<{
      caller: 'publicLogin';
      atRead: AtRead<AnyLogin | NextResponse | RouteRefusal, { audit: boolean }>;
    }>
  | Readonly<{ caller: 'cookieUpgrade'; atRead: AtRead<CookieUpgradeLogin | NextResponse, null> }>
  | Readonly<{ caller: 'ownerAtRead'; atRead: AtRead<SessionUser | NextResponse, null> }>;

/** What getReaderForAsset answers when it lets a login through: the Admin
 *  user (or the member's view of the anchor), and the member, null for an
 *  Admin user. */
export type AssetReader = { user: SessionUser; member: MemberCaller | null };

/**
 * An answer the gate binds for the handler's first read to run (A4 hand
 * batch B, route-policy.ts ANSWERED_AT_READ): the guard of the row's kind,
 * run once, in the handler's own place, where the handler called it before,
 * so whatever the handler did first still comes first and the effects of
 * the answer (a device token's stamp, the actor named, an audit row) fall
 * where they fell. Every later read is the same answer. A read with other
 * options than the first throws: a row has one answer.
 */
class AtRead<T, O> {
  #taken: Promise<T> | null = null;
  #asked: string | null = null;
  constructor(private readonly run: (opts: O) => Promise<T>) {}

  take(opts: O): Promise<T> {
    const asked = JSON.stringify(opts);
    if (this.#taken) {
      if (asked !== this.#asked) {
        throw new Error(`the answer of this request was read with ${this.#asked}, not ${asked}`);
      }
      return this.#taken;
    }
    this.#asked = asked;
    this.#taken = this.run(opts);
    return this.#taken;
  }
}

/**
 * The refusal of an answer taken at the read (ownerCallerAtRead, A4 hand
 * batch B): thrown out of the handler, where the guard's refusal was
 * returned before, and answered by the app's onError as it is
 * (server/app-error.ts), with the gate's CORS headers. The handler cannot
 * answer anything else in its place.
 */
export class RouteRefusal extends Error {
  constructor(readonly response: NextResponse) {
    super('the request was refused');
    this.name = 'RouteRefusal';
  }
}

/**
 * The gate's step for a row whose handler reads the caller the pipeline
 * answers (`row.caller`, from the route file's code: the manifest's
 * `reads`): it runs the guard of the row's caller kind once, before the
 * handler, in the request slot enterCall opened, and so does what the
 * guard did on the side, from the row. The owner guard
 * (getOwnerOr401WithLogin): the login's actor named (and a device token's
 * stamp), the scope entered or the system reason noted (self, area, an
 * Admin write), the item a write names checked, the
 * create home named, the audit row of a write. The member guard
 * (getMemberOr401, A4 step 3b part 5): the member named, its scope entered
 * or its own rule noted, a key's write audited. The any-login guard
 * (getLoginOr401) and the chat guard (getChatLoginOr401): the login named,
 * its scope entered or the system reason noted (anyLoginScope), the audit
 * row each role's own gate writes. The asset guards (A4 hand batch B) on
 * the request as the handler is handed it. A refusal is the gate's answer
 * (the handler does not run); otherwise the answer is kept on the
 * request's logins for the row's reader. A kind answered at the read
 * (ANSWERED_AT_READ) keeps its guard for the handler's first read to run.
 * The same function the guard runs, so the two cannot answer differently.
 */
export async function answerRouteCaller(row: RouteRow): Promise<NextResponse | null> {
  if (!row.caller) return null;
  const logins = boundLogins(currentCaller());
  // The gate binds the request's logins on every routed request
  // (resolveHttpLogin): without them nothing could read the answer.
  if (!logins) throw new Error(`answerRouteCaller: ${row.key} has no logins bound`);
  const got = await guardAnswer(row);
  if (got instanceof NextResponse) return got;
  logins.keepAnswer(got);
  return null;
}

/** The scope of the limits taken at a public row's read: the login's. */
const LOGIN_SCOPE: ReadonlySet<'login'> = new Set(['login']);

/**
 * The login a row's login limit counts (route-limits.ts; A10 #8), from the
 * answer the pipeline gave (answerRouteCaller): the owner guard's login (a
 * member's own id where a member called, as the app runner counted it; an
 * Admin user's actor), the member, the any-login and chat logins, a byte
 * route's reader. Null where the answer names none (no answer yet, a kind
 * answered at the read, which takes its limit there).
 */
export function answeredLimitLogin(): LimitLogin | null {
  const answer = boundLogins(currentCaller())?.answer;
  switch (answer?.caller) {
    case 'owner': {
      const { owner } = answer;
      return owner.member
        ? { loginId: owner.member.loginId, member: true }
        : { loginId: owner.user.actor.id, member: false };
    }
    case 'member':
      return { loginId: answer.member.loginId, member: true };
    case 'login':
      return { loginId: answer.login.loginId, member: legacyLogin(answer.login).kind === 'member' };
    case 'chat':
      return { loginId: answer.chat.loginId, member: answer.chat.kind === 'member' };
    case 'readerAsset': {
      const { reader } = answer;
      return reader.member
        ? { loginId: reader.member.loginId, member: true }
        : { loginId: reader.user.actor.id, member: false };
    }
    default:
      return null;
  }
}

/** The request a byte route's handler is handed (the asset guards read its
 *  `?at=` token, its path and its method): the request as sent, or as the
 *  route file hands it on (route-policy.ts ASSET_QUERY_AS_HANDED). */
function assetRequest(row: RouteRow): Request {
  const req = getRequestContext()?.req;
  if (!req) throw new Error(`answerRouteCaller: ${row.key} has no request`);
  const query = assetQueryAsHanded(row);
  if (query === null) return req;
  const url = new URL(req.url);
  url.search = query;
  return new Request(url, { method: 'GET', headers: req.headers });
}

/** The frame ticket a frame document's `?t=` carries, verified, or null
 *  (pure: the signature and the claims, no lookup). */
function frameTicketOf(req: Request): AppFrameTicket | null {
  const t = new URL(req.url).searchParams.get('t');
  return t ? verifyAppFrameTicket(t) : null;
}

/** The answer of the guard of the row's caller kind (the guard itself, run
 *  once). A gone row (RouteRow.gone, a retired route's 410 stub) is
 *  answered as its stub's guard answered: the any-login one with no audit
 *  row. */
async function guardAnswer(row: RouteRow): Promise<PipelineAnswer | NextResponse> {
  const caller = row.caller!;
  switch (caller) {
    case 'owner': {
      const owner = await getOwnerOr401WithLogin();
      return owner instanceof NextResponse ? owner : { caller, owner };
    }
    case 'member': {
      const member = await getMemberOr401();
      return member instanceof NextResponse ? member : { caller, member };
    }
    case 'login': {
      // The any-login answer writes the generic api.write row its rows
      // wrote by hand after the guard before (A4 hand batch A); a gone stub
      // never wrote one.
      const login = await getLoginOr401({ audit: !row.gone });
      return login instanceof NextResponse ? login : { caller, login };
    }
    case 'chat': {
      const chat = await getChatLoginOr401();
      return chat instanceof NextResponse ? chat : { caller, chat };
    }
    case 'session':
      // Any Admin user, or null (A4 hand batch A): never a refusal, the
      // handler answers a null as it did (the rows open to every Admin
      // user, ADMIN_OPEN_ROWS).
      return { caller, user: await getSessionUser() };
    case 'ownerAsset': {
      const user = await getOwnerForAsset(assetRequest(row));
      return user instanceof NextResponse ? user : { caller, user };
    }
    case 'readerAsset': {
      const reader = await getReaderForAsset(assetRequest(row));
      return reader instanceof NextResponse ? reader : { caller, reader };
    }
    case 'frame': {
      // The ticket only (A4 hand batch B): the handler checks it names this
      // app and that its login is still active, as it did.
      const req = getRequestContext()?.req;
      if (!req) throw new Error(`answerRouteCaller: ${row.key} has no request`);
      return { caller, ticket: frameTicketOf(req) };
    }
    case 'publicLogin':
      // A login limit of the row (route-limits.ts) is taken here, at the
      // read, where the handler took it after its read before (A10 #8): no
      // login spends nothing, and what the handler checked first still
      // comes first. Over the limit, the read throws the one 429.
      return {
        caller,
        atRead: new AtRead(async (opts) => {
          const got = await getLoginOr401(opts);
          if (got instanceof NextResponse) return got;
          const login = legacyLogin(got);
          if (!row.rateLimit.length) return login;
          const req = getRequestContext()?.req;
          if (!req) throw new Error(`answerRouteCaller: ${row.key} has no request`);
          const over = takeRouteLimits(row.rateLimit, {
            req,
            login: { loginId: login.loginId, member: login.kind === 'member' },
            scopes: LOGIN_SCOPE,
          });
          return over ? new RouteRefusal(over) : login;
        }),
      };
    case 'cookieUpgrade':
      return { caller, atRead: new AtRead(() => getCookieUpgradeLoginOr401()) };
    case 'ownerAtRead':
      return {
        caller,
        atRead: new AtRead(async () => {
          const got = await getOwnerOr401WithLogin();
          return got instanceof NextResponse ? got : got.user;
        }),
      };
  }
}

/**
 * The owner the pipeline answered for this request (answerRouteCaller):
 * the owner guard's user (getOwnerOr401WithLogin, which replaced
 * getOwnerOr401 at A4 exit), read from the bound caller, with no lookup
 * and no effect (the gate did both). A handler reads it in place of the
 * guard:
 *
 *     const owner = ownerCaller();
 *
 * There is no refusal to return: the gate refused before the handler ran.
 * It throws where the pipeline answered no owner: a row with no `caller`
 * (the generator did not see the read), or another kind's; a call nested in the
 * request with a caller of its own; outside a routed request (a test
 * calling a handler goes through runRoute). Fail closed: never a login
 * nobody checked.
 */
export function ownerCaller(): SessionUser {
  return pipelineAnswer('ownerCaller', 'owner').owner.user;
}

/**
 * The owner guard's owner and how the request authenticated (what the
 * retired getOwnerOr401WithSource answered), read from the pipeline's answer as ownerCaller() reads
 * it: no lookup, no effect, and the same throw where the pipeline answered
 * no owner. A handler reads it in place of the guard:
 *
 *     const { user, source } = ownerCallerWithSource();
 */
export function ownerCallerWithSource(): { user: SessionUser; source: AuthSource } {
  const { owner } = pipelineAnswer('ownerCallerWithSource', 'owner');
  return { user: owner.user, source: owner.source };
}

/**
 * What getOwnerOr401WithLogin answers (the owner, how the request
 * authenticated, and the login's kind, `member` set for a member), read
 * from the pipeline's answer as ownerCaller() reads it: no lookup, no
 * effect, and the same throw where the pipeline answered no owner.
 */
export function ownerCallerWithLogin(): OwnerRouteLogin {
  return { ...pipelineAnswer('ownerCallerWithLogin', 'owner').owner };
}

/**
 * The member the pipeline answered for this request (A4 step 3b part 5):
 * what getMemberOr401 answers, on a member route (the member list), read
 * from the pipeline's answer as ownerCaller() reads the owner: no lookup,
 * no effect, and a throw where the pipeline answered no member. A handler
 * reads it in place of the guard:
 *
 *     const member = memberCaller();
 */
export function memberCaller(): MemberCaller {
  return { ...pipelineAnswer('memberCaller', 'member').member };
}

/**
 * The login the pipeline answered for this request (A4 step 3b part 5):
 * what getLoginOr401 answers, on an any-login route (the any-login list),
 * read from the pipeline's answer as ownerCaller() reads the owner: no
 * lookup, no effect, and a throw where the pipeline answered no login.
 * In its legacy shape (a transition adapter, see AnyLogin) while the
 * handlers still branch on `kind`.
 */
export function loginCaller(): AnyLogin {
  return { ...legacyLogin(pipelineAnswer('loginCaller', 'login').login) };
}

/**
 * The chat login the pipeline answered for this request (A4 step 3b part
 * 5): what getChatLoginOr401 answers, on a chat or Telegram chat route,
 * read from the pipeline's answer as ownerCaller() reads the owner: no
 * lookup, no effect, and a throw where the pipeline answered no chat
 * login. A handler reads it in place of the guard:
 *
 *     const login = chatLoginCaller();
 */
export function chatLoginCaller(): ChatLogin {
  return { ...pipelineAnswer('chatLoginCaller', 'chat').chat };
}

/**
 * The session user the pipeline answered for this request (A4 hand batch
 * A): what getSessionUser answers, any Admin user or null (a member, no
 * login), on a row open to every Admin user (route-policy.ts
 * ADMIN_OPEN_ROWS), read from the pipeline's answer as ownerCaller() reads
 * the owner: no lookup, no effect, and a throw where the pipeline answered
 * no session user. The gate refuses nothing for it: the handler answers a
 * null, as it did after the guard.
 *
 *     const user = sessionUserCaller();
 *     if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
 */
export function sessionUserCaller(): SessionUser | null {
  return pipelineAnswer('sessionUserCaller', 'session').user;
}

/**
 * The Admin user (or a member's view) the pipeline answered for a byte
 * route (A4 hand batch B): what getOwnerForAsset answers, its session, a
 * `?at=` asset token or the render cookie, read from the pipeline's answer
 * as ownerCaller() reads the owner: no lookup, no effect, and a throw where
 * the pipeline answered none.
 */
export function ownerAssetCaller(): SessionUser {
  return pipelineAnswer('ownerAssetCaller', 'ownerAsset').user;
}

/**
 * Who reads a byte route of brain items (A4 hand batch B): what
 * getReaderForAsset answers, an Admin user (`member` null) or a member on a
 * read open to it, read from the pipeline's answer as ownerCaller() reads
 * the owner.
 */
export function readerAssetCaller(): AssetReader {
  return { ...pipelineAnswer('readerAssetCaller', 'readerAsset').reader };
}

/**
 * The frame ticket a sandbox frame document was opened with (A4 hand batch
 * B): the `?t=` the gate admitted, verified (verifyAppFrameTicket), or null.
 * No login is resolved for these rows; the handler checks the ticket names
 * its app and that its login is still active.
 */
export function frameTicketCaller(): AppFrameTicket | null {
  return pipelineAnswer('frameTicketCaller', 'frame').ticket;
}

/**
 * The login a public row reads (A4 hand batch B): what getLoginOr401
 * answers, taken at this read, where the handler called the guard before
 * (its own checks come first: the cross-site refusal, the body, the remote
 * MCP switch and the client's validation). Never a refusal: no login is
 * null, and the handler answers it as it did (unauthorizedRefusal(), its
 * own words, or carrying on). `audit`: the generic api.write row of a
 * write, as the guard's `audit` (POST /api/auth/pair). The first read runs
 * the answer; a later one is the same answer.
 *
 *     const login = await publicLoginCaller();
 *     if (!login) return unauthorizedRefusal();
 */
export async function publicLoginCaller(opts: { audit?: boolean } = {}): Promise<AnyLogin | null> {
  const atRead = pipelineAnswer('publicLoginCaller', 'publicLogin').atRead;
  const got = await atRead.take({ audit: opts.audit === true });
  // Over the row's login limit (A10 #8): the one 429, answered by the app
  // as the handler's 429 was returned.
  if (got instanceof RouteRefusal) throw got;
  return got instanceof NextResponse ? null : { ...got };
}

/** What getCookieUpgradeLoginOr401 answers when it lets a login through. */
export type CookieUpgradeLogin = Exclude<
  Awaited<ReturnType<typeof getCookieUpgradeLoginOr401>>,
  NextResponse
>;

/**
 * The login POST /api/auth/sso turns into a session cookie (A4 hand batch
 * B): what getCookieUpgradeLoginOr401 answers (the device token only),
 * taken at this read, after the route's throttle and origin check, as the
 * guard was called. Null where it refused (no device token).
 */
export async function cookieUpgradeCaller(): Promise<CookieUpgradeLogin | null> {
  const got = await pipelineAnswer('cookieUpgradeCaller', 'cookieUpgrade').atRead.take(null);
  return got instanceof NextResponse ? null : { ...got };
}

/**
 * The owner of a row whose handler runs checks of its own before it reads
 * the owner (A4 hand batch B: PATCH /api/pages/:id, whose /api/v1 wrapper
 * holds an API key to its rules first): the owner guard's user, taken
 * at this read, with its effects (the item a write names checked, the
 * audit row) where the guard had them. A refusal is thrown (RouteRefusal)
 * and answered by the app as the guard's was returned: the handler goes no
 * further and cannot answer in its place.
 */
export async function ownerCallerAtRead(): Promise<SessionUser> {
  const got = await pipelineAnswer('ownerCallerAtRead', 'ownerAtRead').atRead.take(null);
  if (got instanceof NextResponse) throw new RouteRefusal(got);
  return got;
}

/** The 401 a session guard answers no login with (`unauthorized`, the one
 *  mapper): what a handler answers a null public login with, as its guard's
 *  refusal was. */
export function unauthorizedRefusal(): NextResponse {
  return accessRefusal(new AccessError('unauthorized'));
}

/** What the pipeline answers for each caller kind, in a reader's refusal. */
const ANSWERED: Readonly<Record<RouteCaller, string>> = {
  owner: 'owner',
  member: 'member',
  login: 'login',
  chat: 'chat login',
  session: 'session user',
  ownerAsset: 'asset owner',
  readerAsset: 'asset reader',
  frame: 'frame ticket',
  publicLogin: 'public login',
  cookieUpgrade: 'cookie upgrade login',
  ownerAtRead: 'owner at the read',
};

/** The guard's answer the pipeline gave (answerRouteCaller) for a row of
 *  caller kind `caller`, which the readers project; throws where it gave
 *  none, or another kind's (fail closed). */
function pipelineAnswer<K extends RouteCaller>(
  reader: string,
  caller: K,
): Extract<PipelineAnswer, { caller: K }> {
  const answer = boundLogins(currentCaller())?.answer;
  if (answer?.caller !== caller) {
    throw new Error(
      `${reader}(): the pipeline answered no ${ANSWERED[caller]} for this request ` +
        `(the row's caller is ${answer?.caller ?? 'none'})`,
    );
  }
  return answer as Extract<PipelineAnswer, { caller: K }>;
}

/** Whether `loginId` holds `area`: the Admin view the gate resolved for
 *  this login on this row, else requireArea's answer (loginHoldsArea). */
async function holdsArea(
  loginId: string,
  area: import('@mantle/client-types').WorkspaceArea,
): Promise<boolean> {
  const caller = currentCaller();
  const logins = boundLogins(caller);
  // The gate's view, unless the request has changed a login since (forget).
  const view =
    logins && !logins.changed ? (caller?.facts?.[HTTP_ADMIN] as AdminView | undefined) : null;
  if (view && caller?.loginId === loginId) return view.areas.has(area);
  return loginHoldsArea(loginId, area);
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

/**
 * Gate for the render surfaces (/print/pages, /print/draws, /render/draws).
 * An admin session opens them as before; otherwise the render cookie the
 * browser sidecar carries, and only for the node that cookie names. Redirects
 * to /login.
 */
export async function requireOwnerForRender(nodeId: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user) return user;
  const render = await renderCaller();
  if (render && render.nodeId === nodeId) return render.user;
  redirect('/login');
}

/**
 * Audit hook of the session guards (the owner guard, the member, any-login
 * and chat guards, the cookie upgrade), which the gate runs for every row
 * that reads a caller. For a write (learned from the middleware-injected
 * x-mantle-method/-path headers, which clients can't spoof, and the routed
 * request's row: auditsAsWrite) it fire-and-forgets a generic `api.write`
 * row recording who did what — unless the route logs its own richer event
 * (`AUDIT_SELF_LOGGED_PATHS`). Reads aren't logged; a GET whose row is a
 * write (a connector's OAuth callback, WRITE_GETS) is.
 */
async function auditMutation(user: SessionUser, skip?: (path: string) => boolean): Promise<void> {
  const h = await headers();
  const method = (h.get(MANTLE_METHOD_HEADER) ?? '').toUpperCase();
  const path = h.get(MANTLE_PATH_HEADER) ?? '';
  const mutating = auditsAsWrite(method, currentRoute()?.effect ?? null);
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
    // The key's maker too: a key that acts as a member logs its
    // writes under that login, and the maker is who to ask (audit item 8).
    ...(key
      ? { detail: { keyId: key.id, keyPrefix: key.prefix, keyCreatedBy: key.createdBy } }
      : {}),
  });
}

/** What getOwnerOr401WithLogin answers: the login's kind, and `member` set
 *  exactly when it is a member. */
export type OwnerRouteLogin =
  | { kind: 'admin'; user: SessionUser; source: AuthSource; member: null }
  | { kind: 'member'; user: SessionUser; source: AuthSource; member: MemberCaller };

/**
 * The owner guard (A4 exit: the gate runs it for an owner row,
 * answerRouteCaller; a handler reads ownerCaller() and its projections): the
 * owner, how the request authenticated ('web' cookie, 'mobile' bearer,
 * 'api' key), and WHO the login is: its `kind`, and `member` set for a
 * member on an owner route open to it (W7e: the app runner routes run a
 * member at the team rules, an Admin user at the app's). A refusal is a 401
 * JSON response, never a redirect: a revoked or expired bearer slips past
 * the stateless gate check and is caught here.
 */
export async function getOwnerOr401WithLogin(): Promise<OwnerRouteLogin | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  if (res.kind !== 'admin') {
    // A member reaches an owner route to read brain items in its
    // own scope (W6a, MEMBER_OPEN_READS; drafts where it may edit, W6b), or
    // to create, edit and delete them there (W6b, MEMBER_OPEN_WRITES); every
    // other owner route refuses it (member routes use getMemberOr401; the
    // sweeps check both).
    const route = guardRoute();
    if (route === UNROUTED) return unroutedRefusal();
    if (route === OUTSIDE) return loginRefused(res.kind);
    const login = res.member;
    const user: SessionUser = {
      id: login.anchorId,
      email: login.email,
      actor: {
        id: login.loginId,
        email: login.email,
        displayName: login.displayName,
        isOwner: false,
      },
    };
    const who: OwnerRouteLogin = { kind: 'member', user, source: res.source, member: res.member };
    if (memberOpenRead(route)) {
      await enterLoginScope(login.loginId, requestMode(true));
      return who;
    }
    if (!memberOpenWrite(route)) return loginRefused(res.kind);
    const refused = await enterLoginWrite(login.loginId, route, { admin: false });
    if (refused) return refused;
    await auditMutation(user);
    return who;
  }
  const refused = await adminRouteGate(res.user.actor.id);
  if (refused) return refused;
  await auditMutation(res.user);
  return { kind: 'admin', user: res.user, source: res.source, member: null };
}

// ── The request scope (workspaces W6a, plan 2.4 and T4) ─────────────────────

/** No request slot: a test calling a handler, a worker (guardRoute). */
const OUTSIDE = 'outside';
/** A request slot with no ROUTE_POLICY row (guardRoute). */
const UNROUTED = 'unrouted';

/**
 * The ROUTE_POLICY row a session guard serves (A4 step 1 fix round 1, M1):
 * the routed request's row (currentRoute(): on the request context, so a
 * call nested inside the request with a caller of its own still reads
 * it); OUTSIDE when no request slot is open, where nothing changes;
 * UNROUTED when a request slot is open with no row. Only the gate opens a
 * slot, always with its row, so UNROUTED is refused ('unclassified', fail
 * closed: unroutedRefusal), never taken for outside a request.
 */
function guardRoute(): RouteRow | typeof OUTSIDE | typeof UNROUTED {
  if (!hasRequestSlot()) return OUTSIDE;
  return currentRoute() ?? UNROUTED;
}

/** The refusal of a request slot with no row: no policy (the gate's step
 *  3), answered by the one mapper. */
function unroutedRefusal(): NextResponse {
  return accessRefusal(new AccessError('unclassified'));
}

/** The mode of a request scope for the current request: it writes when
 *  its ROUTE_POLICY row does (outside a routed request, when its method
 *  is not a GET or a HEAD). */
function requestMode(drafts: boolean): RequestScopeMode {
  const route = currentRoute();
  if (route) return { writes: route.effect === 'write', drafts };
  const method = (getRequestContext()?.method ?? 'GET').toUpperCase();
  return { writes: method !== 'GET' && method !== 'HEAD', drafts };
}

/** Enter `loginId`'s scope for the rest of the request (no-op when it is
 *  already in, or outside a routed request). */
async function enterLoginScope(loginId: string, mode: RequestScopeMode): Promise<boolean> {
  if (!hasRequestSlot()) return false;
  const done = currentRequestOutcome();
  if (done?.kind === 'user' && done.loginId === loginId.toLowerCase()) return true;
  return enterRequestScope(await loginScopeFor(loginId), mode);
}

/** Whether the login holds `area` (requireArea's rule: the Admin workspace
 *  and its limits). */
async function loginHoldsArea(
  loginId: string,
  area: import('@mantle/client-types').WorkspaceArea,
): Promise<boolean> {
  const anchorId = await getAnchorId();
  if (!anchorId) return false;
  const { requireArea } = await import('../workspaces');
  return requireArea({ loginId, anchorId, user: null }, area);
}

/**
 * What an Admin login's owner request runs as (W6a): a management route
 * needs its area and runs on the system pool; the login's own things run
 * there too; a read or a write of brain items enters the login's scope
 * (a write since F4, as a member's: enterLoginWrite).
 * Outside a request slot (a test calling a handler) nothing changes; a
 * request slot with no row is refused (guardRoute). Returns the refusal,
 * or null to go on.
 */
async function adminRouteGate(loginId: string): Promise<NextResponse | null> {
  const route = guardRoute();
  if (route === UNROUTED) return unroutedRefusal();
  if (route === OUTSIDE) return null;
  const cls = route.scope;
  // The gate's refusals, answered by the one mapper (arch A3c): no route
  // class is step 3 (no policy), an area the login lacks step 5.
  if (!cls) return accessRefusal(new AccessError('unclassified'));
  if (cls.kind === 'area') {
    // On a row whose handler reads the pipeline's caller the gate's step 5
    // refused a login without the area already (A4 step 3b part 4); this
    // is the guard's own check, for the rows that still call it.
    // TODO(A4 exit): folds into the gate's step 5 when the last guard goes.
    if (!(await holdsArea(loginId, cls.area))) {
      return accessRefusal(new AccessError('area', undefined, { area: cls.area }));
    }
    noteRequestSystem('area');
    return null;
  }
  if (cls.kind === 'self') {
    noteRequestSystem('login-self');
    return null;
  }
  if (route.effect === 'write') return enterLoginWrite(loginId, route, { admin: true });
  await enterLoginScope(loginId, requestMode(true));
  return null;
}

/**
 * A login's write request to brain items (W6b for a member; an Admin user's
 * since F4, which ran on the system pool with its reads unscoped before):
 * the item the route names is checked first (itemWriteGate), the create
 * home recorded (createHomeFor: an Admin user without ?ws= creates as
 * before, the folder's home else Admin; a member's private workspace is
 * its fallback), then the request runs in the login's scope for the rest
 * of the request, reads and writes alike: its reads on the workspace role,
 * its writes through the login write gateway (loginWriteRoute: the write
 * role while the actor check is warn or on, where the database's write and
 * edit checks answer for every statement). An Admin user's Admin rights
 * are in that scope (the Admin workspace and its limits:
 * mantle_scope_has_admin, mantle_scope_has_area), so the database answers
 * for them too. Returns the refusal, or null to go on.
 *
 * No write is kept on the system pool since plan v3.2 S6 c3: the Admin acts
 * (a contact's sharing, sharing with contacts, Revoke all of a contact's
 * shares, an entity merge; the share close by the users area, a contact
 * share's "Can write", the deleted apps' trash) run in the login's scope,
 * each asking its definer, which checks the Admin user inside (0308, 0310).
 */
async function enterLoginWrite(
  loginId: string,
  route: RouteRow,
  opts: { admin: boolean },
): Promise<NextResponse | null> {
  const refused = await itemWriteGate(loginId, route);
  if (refused) return refused;
  // A create lands in the request's workspace (?ws=) when the login
  // moderates it (W6b); else by the login's default home rule.
  const home = await createHomeFor(loginId, route, !opts.admin);
  if (home instanceof NextResponse) return home;
  noteRequestCreateHome(home);
  await enterLoginScope(loginId, requestMode(true));
  return null;
}

/** The item id a path segment names: the segment decoded, the value the
 *  handler gets (Hono decodes the path and its params before routing), so
 *  an encoded id is checked as the id it names. Null when the segment does
 *  not decode or is not an item id. */
function itemIdOf(segment: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return UUID_RE.test(id) ? id : null;
}

/**
 * A login's write to one item (W6a, plan S1; every login since W6b): allowed
 * only when the login's scope may edit the item (mantle_may_edit: a Moderator of its
 * home, or a Write grant to one of its workspaces), manage it for a delete
 * or a move (mantle_may_manage), or read it for its own marks and app runs.
 * An item the login's scope does not read is refused with the same 404 as
 * an id no row has, for every login (an Admin user too since F4, owner
 * decision D2: it was told to add itself to the item's workspace first, a
 * 403 that told the item existed), so no item's existence leaves its scope
 * (docs/workspaces.md: "not found", never "exists but no"; audit
 * 2026-10-12). The rule is the database's, asked in the login's scope; the
 * write itself then runs in that scope (enterLoginWrite), where the
 * database's own checks answer again. A read-only snapshot
 * copy (data.snapshot_of) is never edited, by anyone; its author may still
 * delete it (W6b fix round 1,
 * CEO decision 2). The item id is the decoded path segment (itemIdOf); one
 * that is not an item id is the not-found answer, for every login.
 *
 * No route names an item for it now (route-scope.ts itemWriteTarget): the
 * pre-check removal part 2 took the item routes' entries, plan v3.2 S6 c2
 * the last two (a share, a deleted app: their handlers ask, shareItemRefusal
 * and mantle_app_trash_act). The pre-check removal cells still feed it the
 * old node targets (precheck-removal-http.db.test.ts) to record what it
 * answered.
 */
async function itemWriteGate(loginId: string, route: RouteRow): Promise<NextResponse | null> {
  const path = getRequestContext()?.path;
  const target = path ? routeItemTarget(route, path) : null;
  if (!target) return null;
  const need = target.need;
  // The id the handler gets. A segment that does not decode to an item id
  // is refused with the not-found answer, never skipped: the check read the
  // raw segment once, so an encoded id skipped it while the handler got
  // the decoded one and wrote.
  const nodeId = itemIdOf(target.id);
  if (nodeId === null) return itemNotFound();
  const rows = (await withViewer({ login: loginId }, () =>
    db.execute(sql`
      select ${mayEditSql('n')} as edit, ${mayManageSql('n')} as manage,
             coalesce(n.data ? 'snapshot_of', false) as copy
        from nodes n where n.id = ${nodeId}`),
  )) as unknown as { edit: boolean | null; manage: boolean | null; copy: boolean }[];
  const row = rows[0];
  // Not in the scope. A login is told nothing about an item it does not
  // read, whatever the write needs: the same 404 as an id no row has (an
  // Admin user too since F4, D2: it heard "Add yourself to it first", a 403
  // that told the item existed).
  if (!row) return itemNotFound();
  if (need === 'read') return null;
  // A read-only snapshot copy: deleted or filed by its home's Moderator
  // (the database keeps it in its private workspace), never edited.
  const readOnlyCopy = row.copy === true && need === 'edit';
  if (!readOnlyCopy && (need === 'edit' ? row.edit === true : row.manage === true)) return null;
  return itemRefused(readOnlyCopy);
}

/**
 * Where a create through `method pattern` lands (W6b, plan 15 and 21.8 row
 * 7), or a refusal. `?ws=<id>` names the request's workspace: a login that
 * is not in it is refused (403 workspace); one that moderates it creates
 * there; one that only reads it creates as if it had not named one. For a
 * non-Admin login (`ownWork`) the private workspace is the fallback (made
 * now when it has none): the folder it creates in when it may edit that,
 * else its private workspace, never Admin. An Admin user without ?ws=
 * creates as before. Not a create: nothing to record (null createWs, and
 * the private workspace only for a non-Admin login's other writes, which
 * may make an item too, such as a commit that makes a copy).
 */
async function createHomeFor(
  loginId: string,
  route: RouteRow,
  ownWork: boolean,
): Promise<CreateHome | NextResponse> {
  // THE create-home intent (arch A3c): @mantle/db createHomeIntent, shared
  // with assistant turns and MCP.
  const home = await createHomeIntent(
    ...requestCreateHomeArgs(loginId, route, getRequestContext()?.req?.url ?? null, ownWork),
  );
  if ('refused' in home) {
    // Answered by the one mapper: 400 invalid, else 403 workspace, the
    // bodies as before.
    return accessRefusal(
      new AccessError(home.refused === 'invalid' ? 'invalid' : 'workspace', home.message),
    );
  }
  return home;
}

/**
 * The create-home intent's arguments for a write request (createHomeFor),
 * from its ROUTE_POLICY row (`creates`, `makesItems`): whether it is a
 * create route (only then is its `?ws=` read) and whether it may make an
 * item. A write that makes no item (a delete, a pin, an opened mark) never
 * makes the private workspace (W6b fix round 1): its existing one, if any,
 * else none. Any other write may make it: a create, and also an edit, a
 * move or a copy (fix round 2: such a write may land a new item, and with
 * no private workspace named its home would fall back to the rule before
 * W6b, the folder's home else Admin, so it is not narrowed to the create
 * routes). create-home-parity.test.ts pins the gate's step 6 with the same
 * two fields against this.
 */
export function requestCreateHomeArgs(
  loginId: string,
  route: Pick<RouteRow, 'creates' | 'makesItems'>,
  url: string | null,
  ownWork: boolean,
): Parameters<typeof createHomeIntent> {
  const askedWs = route.creates && url ? new URL(url).searchParams.get('ws') : null;
  return [loginId, { from: 'param', ws: askedWs }, { ownWork, makePrivate: route.makesItems }];
}

/** A refusal of the gate as its HTTP answer: the one mapper's
 *  (@mantle/std mapAccessError, arch A3c), the bodies the guards sent. */
function accessRefusal(err: AccessError): NextResponse {
  const { status, body } = mapAccessError(err)!.http!;
  return NextResponse.json(body, { status });
}

/** The 403 a gate answers a login of the wrong kind with. The reason names
 *  the CALLER's kind: `member-login`, or `admin-login` from a member
 *  route. */
export function loginRefused(kind: Resolved['kind']): NextResponse {
  const body =
    kind === 'member'
      ? { reason: 'member-login', message: 'Not available to member logins.' }
      : { reason: 'admin-login', message: 'This route is for member logins.' };
  return NextResponse.json({ error: 'forbidden', ...body }, { status: 403 });
}

/**
 * The member gate (member logins, Phase 1): a MEMBER login, or 401 (no
 * session) / 403 (an admin: member routes are member-specific, never a
 * shared owner route). Only for routes in MEMBER_ROUTES
 * (lib/auth/member-routes.ts); run the handler's reads under
 * `withViewer(…)`.
 */
export async function getMemberOr401(): Promise<MemberCaller | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  // A member and nothing else: an admin gets admin-login.
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
  // A member route that reads brain items runs in the login's request scope
  // (W7e); one about the login's own things holds its own rule (W6a).
  return (await memberRouteScope(res.member.loginId)) ?? res.member;
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
 *  row is re-read, so a disabled, demoted or removed from Admin login stops
 *  at once (adminLogin). */
export async function adminLoginActive(loginId: string): Promise<boolean> {
  const row = await loadLoginRow(loginId);
  return !!row && adminLogin(row) && loginUsable(row);
}

/** When the calling request's session cookie expires (ms since epoch), or
 *  null without one. */
export async function sessionCookieExpiryMs(): Promise<number | null> {
  const c = (await cookies()).get(SESSION_COOKIE_NAME);
  const data = c ? verifySessionCookie(c.value) : null;
  return data ? data.exp * 1000 : null;
}

/**
 * The generic `api.write` row for a route any login may call
 * (getLoginOr401 with `audit`: the any-login answer step, POST
 * /api/auth/pair), by the rule each role's own gate follows: an admin's
 * write always, a member's write when it was made with an API key. Reads
 * are not logged, and a path that logs its own richer event is skipped
 * (auditMutation). Written inside the guard, as the member and chat guards
 * write theirs (A4 hand batch A: before, each caller wrote it by hand
 * after the guard).
 */
async function auditLoginMutation(login: AnyLogin): Promise<void> {
  switch (login.kind) {
    case 'admin':
      return auditMutation(login.user);
    case 'member': {
      if (login.source !== 'api') return;
      const m = login.member;
      return auditMutation({
        id: m.anchorId,
        email: m.email,
        actor: { id: m.loginId, email: m.email, displayName: m.displayName, isOwner: false },
      });
    }
  }
}

/**
 * The legacy shape of an any-login caller: the login told apart by its
 * session's role (`kind`), with the admin's session user or the member's
 * record. A transition adapter: getLoginOr401 answers a Login (./login.ts),
 * and the handlers that still branch on `kind` read this through
 * loginCaller() or legacyLogin() until each moves to the Login and
 * adminFacts(). Never a source of a new decision.
 */
export type AnyLogin =
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
    };

/** What getLoginOr401 knew of each Login it answered beyond the Login: its
 *  legacy shape and the row's Admin pair. Keyed on the very object, so a
 *  Login built anywhere else has neither (adminFacts then answers no). */
const loginLegacy = new WeakMap<Login, { any: AnyLogin; adminPair: boolean }>();

/** The legacy shape of a Login getLoginOr401 answered (a transition
 *  adapter, see AnyLogin). Throws for a Login it did not answer: never a
 *  guess. */
export function legacyLogin(login: Login): AnyLogin {
  const got = loginLegacy.get(login);
  if (!got) throw new Error('legacyLogin: not a login getLoginOr401 answered');
  return got.any;
}

/**
 * The row's Admin pair for a Login getLoginOr401 answered: role admin AND a
 * user of the live Admin workspace now (adminLogin, read with the login
 * row). A transition: while the role column can still differ from Admin
 * membership, an Admin answer needs both; once membership decides the role,
 * the scope's own answer is the whole of it. False for a Login it did not
 * answer.
 */
export function loginAdminPair(login: Login): boolean {
  return loginLegacy.get(login)?.adminPair === true;
}

/** The Login and the legacy shape of a resolved caller. */
function loginOf(res: Resolved): { login: Login; any: AnyLogin } {
  if (res.kind === 'admin') {
    const login: Login = {
      loginId: res.loginId,
      brainId: res.user.id,
      email: res.user.actor.email,
      displayName: res.user.actor.displayName,
      contactId: res.contactId,
      source: res.source,
      sessionEpoch: res.epoch,
      actor: res.user.actor,
    };
    return {
      login,
      any: {
        kind: 'admin',
        loginId: res.loginId,
        email: res.user.actor.email,
        source: res.source,
        sessionEpoch: res.epoch,
        user: res.user,
      },
    };
  }
  const m = res.member;
  const login: Login = {
    loginId: res.loginId,
    brainId: m.anchorId,
    email: m.email,
    displayName: m.displayName,
    contactId: m.contactId,
    source: res.source,
    sessionEpoch: res.epoch,
    actor: { id: m.loginId, email: m.email, displayName: m.displayName, isOwner: false },
  };
  return {
    login,
    any: {
      kind: 'member',
      loginId: res.loginId,
      email: m.email,
      source: res.source,
      sessionEpoch: res.epoch,
      member: m,
    },
  };
}

/** The calling login's own row, whatever its role: for the few routes about
 *  the login itself (change its password, sign out, who am I). Never for
 *  brain data. Whether it is an Admin user is adminFacts(login).
 *  `sessionEpoch` is the epoch the credential was verified at, for work that
 *  must still be that session's when it lands (OAuth consent).
 *  `audit`: write the generic api.write row of a write once the login is
 *  let through (auditLoginMutation): the any-login rows (the answer step)
 *  and POST /api/auth/pair ask for it; the routes about the login's own
 *  session (sign out, change password, OAuth consent) never wrote one. */
export async function getLoginOr401(opts: { audit?: boolean } = {}): Promise<Login | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  const refused = await anyLoginScope(res);
  if (refused) return refused;
  const { login, any } = loginOf(res);
  loginLegacy.set(login, { any, adminPair: res.adminPair });
  if (opts.audit) await auditLoginMutation(any);
  return login;
}

/**
 * Who calls a chat route (/api/assistant/*, workspaces W7c): any login, for
 * its own threads only. `user` keeps the owner-route shape (`id` is the
 * brain's anchor, `actor` the login), so the chat helpers take one shape.
 */
export type ChatLogin = {
  kind: LoginRole;
  /** The brain (the anchor login's id). */
  ownerId: string;
  /** The login whose threads this request reads and writes. */
  loginId: string;
  source: AuthSource;
  user: SessionUser;
  displayName: string | null;
  email: string;
};

/**
 * The chat gate (W7c, the owner's answer of 2026-10-11): every login chats
 * with the assistants of its workspaces, each in its own thread, and reads
 * only its own threads. The chat routes are any-login routes
 * (CHAT_LOGIN_ROUTES): a read runs in the login's scope, where row security
 * holds the messages and threads to its own login (0269); every login's
 * write runs there too, an Admin user's as a member's (anyLoginScope).
 * Every chat helper also names the login (lib/assistant.ts,
 * lib/assistant-chat.ts), and the few writes and bookkeeping reads the
 * workspace role has no grant for leave the scope by name (asSystem
 * 'rule-in-query'). Audited as each role's own gate audits.
 */
export async function getChatLoginOr401(): Promise<ChatLogin | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  const refused = await anyLoginScope(res);
  if (refused) return refused;
  if (res.kind === 'admin') {
    await auditMutation(res.user);
    return {
      kind: 'admin',
      ownerId: res.user.id,
      loginId: res.user.actor.id,
      source: res.source,
      user: res.user,
      displayName: res.user.actor.displayName ?? null,
      email: res.user.actor.email,
    };
  }
  const login = res.member;
  const user: SessionUser = {
    id: login.anchorId,
    email: login.email,
    actor: {
      id: login.loginId,
      email: login.email,
      displayName: login.displayName,
      isOwner: false,
    },
  };
  if (res.source === 'api') await auditMutation(user);
  return {
    kind: res.kind,
    ownerId: login.anchorId,
    loginId: login.loginId,
    source: res.source,
    user,
    displayName: login.displayName,
    email: login.email,
  };
}

/**
 * The request scope of getLoginOr401 (W6a). On an any-login route
 * (ANY_LOGIN_ROUTES: shell, workspaces, grants, access keys, whoami; the
 * chat and Telegram pairing routes) every login enters its scope, reads and
 * writes alike: an Admin user's write too since plan v3.2 S6 c3 (its keys,
 * its chat threads and Telegram pairings ran on the system pool with no
 * scope before; the grants and workspaces writes since F4 and S2a a2). The
 * grants and workspace libraries read in the scope (arch A6); the shell,
 * the access keys, whoami, the chat and the pairings hold their rule in
 * their own SQL or definers and leave the scope by name where the scope's
 * roles hold no right (asSystem 'rule-in-query', 'login-telegram'). Anywhere
 * else (sign-out, change password, OAuth consent: the login's own row,
 * never brain data) the request stays on the system pool. Outside a request
 * slot nothing changes; a request slot with no row is refused (guardRoute).
 * Returns the refusal, or null.
 */
async function anyLoginScope(res: Resolved): Promise<NextResponse | null> {
  const route = guardRoute();
  if (route === UNROUTED) return unroutedRefusal();
  if (route === OUTSIDE) return null;
  if (!anyLoginRow(route)) {
    noteRequestSystem('login-self');
    return null;
  }
  await enterLoginScope(res.loginId, requestMode(res.kind === 'admin'));
  return null;
}

/**
 * The login POST /api/auth/sso turns into a session cookie (lib/owner-sso.ts):
 * an admin, audited as every admin call is, or a MEMBER. A member needs the
 * cookie for one thing a bearer cannot do: a top-level navigation to the MCP
 * consent page (GET /api/oauth/authorize) carries cookies only. `epoch` is the epoch the credential
 * was just verified at, so the cookie is signed with that very session's.
 *
 * The DEVICE TOKEN only, never the cookie (access matrix T2): an upgrade
 * from the cookie alone would renew that cookie forever, with no device
 * behind it to revoke. `deviceJti` names the token, and the cookie is bound
 * to it.
 */
export async function getCookieUpgradeLoginOr401(): Promise<
  | { loginId: string; email: string; role: LoginRole; epoch: number; deviceJti: string }
  | NextResponse
> {
  const bearer = await bearerLogin();
  if (!bearer) return accessRefusal(new AccessError('unauthorized'));
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
  // Password sign-in is for admins and members (the only roles since
  // workspaces W8a): a role this code does not know never signs in.
  // Refused like a wrong password (no role oracle).
  const role: string = row.role;
  const passwordRole = isLoginRole(role);
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
  /** `deviceJti`: the device token the cookie rides with (the web client's
   *  upgrade): the cookie then lives only while that device does. */
  opts: { ttlSeconds?: number; deviceJti?: string } = {},
): void {
  const { value, maxAgeSec } = buildSessionCookie(loginId, {
    epoch,
    ttlSeconds: opts.ttlSeconds,
    deviceJti: opts.deviceJti,
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
     *  token presented again (N5). NOT a plain sign-out (M1 audit item
     *  9). */
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
    // The caller forgets again after its commit (updateLogin): a guard read
    // inside the transaction still sees the committed row.
    forgetRequestLogins();
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
  // The request's logins are found afresh on the next guard read (L1).
  forgetRequestLogins();
  // After the commit, so a rolled-back end leaves no row (final audit).
  auditKeysEnded(loginId, opts.actorId ?? loginId, ended);
  auditPeersUnbound(loginId, opts.actorId ?? loginId, unbound, 'sessions-ended');
  opts.unboundPeerIds?.push(...unbound);
  return epoch;
}

/** One key.revoked row for the keys a session end revoked (M2 audit N7):
 *  which login, how many, which. Call it after the revoking transaction
 *  commits. No row when there were none. `reason` says what ended them, as
 *  the peer rows do: the login's MCP switch turned off is 'mcp-off'
 *  (access matrix T17). */
export function auditKeysEnded(
  loginId: string,
  actorId: string,
  keyIds: readonly string[],
  reason: 'sessions-ended' | 'mcp-off' = 'sessions-ended',
): void {
  if (keyIds.length === 0) return;
  auditFireAndForget({
    actorId,
    actorEmail: reason === 'mcp-off' ? 'mcp-switch' : 'session-end',
    action: 'key.revoked',
    detail: { loginId, count: keyIds.length, keyIds: [...keyIds], reason },
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

/** An `?at=` asset token for the anchor's bytes, minted for the login
 *  `loginId` and signed with `sessionEpoch`: the epoch the request's own
 *  credential was checked at (AnyLogin.sessionEpoch), read with the login's
 *  row by the session guard (A6b: the row was read again on the system pool
 *  before, which no scope reads). `ttlSeconds` shortens it (a member's:
 *  SHORT_ASSET_TOKEN_TTL_SECONDS). */
export function mintAssetToken(
  anchorId: string,
  loginId: string,
  sessionEpoch: number,
  opts: { ttlSeconds?: number } = {},
): string {
  return buildAssetToken(anchorId, loginId, sessionEpoch, opts.ttlSeconds);
}
