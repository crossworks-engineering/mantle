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
  onFullSystemRoute,
  onLoginHoldSpot,
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
import { AccessError, defineDomainError, mapAccessError } from '@mantle/std';
import {
  loadAnchorId,
  loadBearerToken,
  loadLoginRow,
  touchBearerToken,
  passwordRuleColumns,
  type LoginRow,
} from './login-row';
import {
  isDetachedDev,
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
import { bearerFromHeader } from './request';
import { PasswordRuleError, passwordProblem, signInNeedsPasswordChange } from './password-rule';
import {
  anyLoginRow,
  assetQueryAsHanded,
  currentRoute,
  findsNoLogin,
  keyOnRow,
  memberOpenRead,
  memberOpenWrite,
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
  verifyCanvasFrameTicket,
  verifyMobileToken,
  verifyRenderToken,
  verifySessionCookie,
  type AppFrameTicket,
} from './tokens';
import { env, passwordPolicyMin } from '@mantle/config';
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
 * The owner routes' handle on the brain (what ownerCaller() answers): `id`
 * is ALWAYS the anchor account's id (all content is keyed to it), so the
 * 280+ `ownerCaller().id` call sites keep querying the one brain no matter
 * who is logged in. `email` is the ACTOR's (display + audit surfaces).
 * Anything login-personal (own password, audit attribution) must use
 * `actor.id`. It carries no kind and no role: whether the login is an Admin
 * user is adminFacts(login) (./login.ts).
 */
export type SessionUser = { id: string; email: string; actor: Actor };

/** How a request authenticated: a session cookie is the web browser; a mobile
 *  bearer token is the phone app (any role) or the split web client. Maps 1:1 onto the inbound
 *  ConversationChannel for web/mobile turns, so a reply/reminder can follow the
 *  surface the user is actually on. See docs/reminder-delivery-routing.md.
 *  'api' is an inbound API key on /api/v1 (no conversation route is there). */
export type AuthSource = 'web' | 'mobile' | 'api';

/**
 * A MEMBER login on a member route: what
 * memberCaller() answers. Deliberately has no `id`: the 280+ call sites that
 * scope by `user.id` cannot take a member by mistake, because the type
 * checker refuses it. A member reaches only the member routes, which read
 * at the team level through RLS (`withViewer(…)`). `role` is the constant
 * 'member' of the member routes' answer (shown, never asked).
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
 *  an email. Admin and member alike. */
export function loginUsable(row: { disabledAt: Date | null; email: string | null }): boolean {
  return !!row.email && !row.disabledAt;
}

/**
 * Whether a login row is an Admin login: a user of the brain's live Admin
 * workspace now, the login enabled (adminMember, mantle_login_is_admin read
 * with the row). Membership decides: the role column follows it, written
 * only by the membership definers (mantle_ws_add_user and
 * mantle_ws_remove_user on Admin), so it is never asked here. The session
 * (resolvedFor) and findMemberAsset ask this; a member is memberLogin.
 */
export function adminLogin(row: Pick<LoginRow, 'adminMember'>): boolean {
  return row.adminMember === true;
}

/** Whether a login row is a member now: a usable login (loginUsable) that
 *  is not an Admin user (adminLogin). */
export function memberLogin(
  row: Pick<LoginRow, 'adminMember'> & { disabledAt: Date | null; email: string | null },
): boolean {
  return loginUsable(row) && !adminLogin(row);
}

/** The role a login is shown with (the gate's caller, whoami, the shell,
 *  an access key's answer): 'admin' for an Admin user, else 'member'. Shown,
 *  never asked: a decision asks adminFacts(login). */
function displayRole(admin: boolean): LoginRole {
  return admin ? 'admin' : 'member';
}

/** The display role of a Login the session guards answered (displayRole of
 *  the row's membership, loginAdminPair): 'member' for a Login they did not
 *  answer. */
export function sessionRole(login: Login): LoginRole {
  return displayRole(loginAdminPair(login));
}

/** Who is calling, resolved from the login row: the login, its brain
 *  handle (`user`: the anchor's id, the login as actor) and whether it is an
 *  Admin user now (`admin`: adminLogin(row), membership; the role is not
 *  asked). One shape for every login (no kind). `epoch`: the
 *  login's session epoch on the row the credential was just checked
 *  against. A login carries no permission of its own: what
 *  it reads and may do is its workspaces'. */
type Resolved = Readonly<{
  loginId: string;
  user: SessionUser;
  source: AuthSource;
  epoch: number;
  contactId: string | null;
  /** adminLogin(row): a user of the live Admin workspace now. */
  admin: boolean;
  /** auth.users.must_change_password and password_checked_min (0347), as
   *  read with the row: the password hold (password-hold.ts) reads them,
   *  only while the box policy sets a password rule. */
  mustChangePassword: boolean;
  passwordCheckedMin: number | null;
}>;

/** The member routes' record of a login that is not an Admin user. */
function memberOf(res: Resolved): MemberCaller {
  return {
    role: 'member',
    loginId: res.loginId,
    anchorId: res.user.id,
    email: res.user.email,
    displayName: res.user.actor.displayName,
    contactId: res.contactId,
  };
}

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
  // The bytes of an item are a read of that item: the Admin user's scope,
  // as on the other owner routes (a render cookie acts for the admin
  // who asked for the print).
  const refused = await adminRouteGate(user.actor.id);
  return refused ?? user;
}

async function ownerForAsset(req: Request): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  if (user) return user;
  // An `?at=` asset token opens a GET only (byte serving; the gate admits it
  // on a GET alone): a HEAD's token is not read (the gate answers a HEAD
  // with only a token 401 first, so only a direct call of this function
  // sees this answer).
  const at = req.method === 'GET' ? new URL(req.url).searchParams.get('at') : null;
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
 * absent, the actor is the anchor itself.
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
  // The render runs as the login the cookie names.
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
 * The byte routes of brain items for EVERY login: an Admin user as
 * getOwnerForAsset (its session, an asset token, the render cookie; `member`
 * null); a member by its session or a member `?at=` token (an <img> src
 * carries no bearer), on a route open to it (memberOpenRead), in its own
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
  if (route === OUTSIDE || !memberOpenRead(route)) return loginRefused(false);
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
 * Where a member route's handler runs: a route that reads brain items
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
  if (res && !res.admin) return memberOf(res);
  // A member's `?at=` token opens a GET only, as ownerForAsset reads the
  // owner's. Unreachable on a HEAD today: the gate admits a token on a GET
  // alone, so a HEAD with only a token is answered 401 before any guard
  // runs. For symmetry, not an answer change.
  const member = req.method === 'GET' ? await requestLogins().memberAsset(req.url) : null;
  return member ?? accessRefusal(new AccessError('unauthorized'));
}

/** The member an `?at=` asset token in `url` was minted for (the member
 *  shell mints it with `act` = the login), with no effect, or null. The
 *  login is re-read, so a disabled login's token, or one whose login was
 *  added to Admin, stops at once. A member is a login that is not an Admin
 *  user (resolvedFor, adminLogin), as on its session. */
async function findMemberAsset(url: string): Promise<MemberCaller | null> {
  const at = new URL(url).searchParams.get('at');
  const claims = at ? verifyAssetToken(at) : null;
  if (!claims?.act) return null;
  const row = await loadLoginRow(claims.act);
  if (!row || !loginUsable(row) || row.sessionEpoch !== claims.ep) return null;
  const resolved = await resolvedFor(row, 'web');
  return resolved && !resolved.admin && resolved.user.id === claims.uid ? memberOf(resolved) : null;
}

/**
 * The login an `?at=` asset token in `url` was minted for, any login (an
 * Admin user's shell mints it with `act` the login, or none for the
 * anchor itself; a member's with `act`), with no effect, or null. The
 * login is re-read: usable, on the session epoch the token carries, and of
 * the brain the token names, so a disabled, signed-out or moved login's
 * token stops at once. Read only on a GET of an any-login asset row
 * (getLoginForAsset).
 */
async function findLoginAsset(url: string): Promise<Resolved | null> {
  const at = new URL(url).searchParams.get('at');
  const claims = at ? verifyAssetToken(at) : null;
  if (!claims) return null;
  const row = await loadLoginRow(claims.act ?? claims.uid);
  if (!row || !loginUsable(row) || row.sessionEpoch !== claims.ep) return null;
  const resolved = await resolvedFor(row, 'web');
  return resolved && resolved.user.id === claims.uid ? resolved : null;
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
 * A login row as the request's login: its brain handle (id = the anchor)
 * and whether it is an Admin user. Membership decides: an Admin
 * login is a user of the brain's live Admin workspace now, the login
 * enabled (adminLogin, the row's adminMember, loginIsAdmin read with the
 * row), never the role column, which follows membership. Only an Admin
 * login's actor may say it is the anchor (isOwner). A row with a role this
 * code does not know (the CHECK admits admin and member only, 0272) is
 * no login (null), never an admin. Null too when the brain has no anchor (a
 * corrupt state).
 */
async function resolvedFor(row: LoginRow, source: AuthSource): Promise<Resolved | null> {
  if (!isLoginRole(row.role)) return null;
  const admin = adminLogin(row);
  const user = await sessionUserFor(admin ? row : { ...row, isOwner: false });
  if (!user) return null;
  return {
    loginId: row.id,
    user,
    source,
    epoch: row.sessionEpoch,
    contactId: row.contactId,
    admin,
    mustChangePassword: row.mustChangePassword === true,
    passwordCheckedMin: row.passwordCheckedMin ?? null,
  };
}

/**
 * The login an inbound API key (`mtlk_`) acts as, found with no effect.
 * `undefined` when the request carries no key; no login when it carries one
 * that is not let in.
 *
 * A key is taken ONLY from the request context, where the gate leaves it
 * after every check passed (server/middleware/access-key-gate.ts: the
 * failed-try budget, the key itself, its rate budget, its scope). It is
 * never verified again here: a request that reached a route
 * without the gate's grant (a public prefix such as /api/auth, or a path
 * shape the gate lets through) has no key login at all.
 *
 * The scope guard runs again here, on the request's
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
  // A read key's request runs as login(ro).
  return { ...NO_LOGIN, resolved, mode: grant.access === 'read_write' ? 'rw' : 'ro' };
}

/** Name the request's actor: the login the guard
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
      loginId: dev.actor.id,
      user: dev,
      source: 'web',
      epoch: 0,
      contactId: null,
      admin: true,
      mustChangePassword: false,
      passwordCheckedMin: null,
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
      // a role change or "sign out everywhere" bumps the row.
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

/** A found login's effects, each time a guard reads it (as if the guard
 *  resolved the login itself): the device token's, then the request's
 *  actor named. */
async function applyLogin(found: FoundLogin): Promise<Resolved | null> {
  await applyBearerEffects(found);
  if (found.resolved && found.mode) nameRequestLogin(found.resolved, found.mode);
  return found.resolved;
}

/** Resolve the calling login, admin or member, cookie first then bearer:
 *  the request's login (the gate found it once), its effects
 *  applied. */
async function resolveLogin(): Promise<Resolved | null> {
  const logins = requestLogins();
  const found = await logins.login();
  // The gate applied this login's effects before its Admin step
  // (enterRouteLogin): the first read takes them as applied, so the device
  // token is stamped once.
  if (logins.takeApplied(found)) return found.resolved;
  return applyLogin(found);
}

// ── The request's logins, found once ────────────────────────────────────────

/**
 * Keep `p` until it fails: a failed find is asked again next time. `drop`
 * gets the failed promise and clears its slot only while the slot still
 * holds that one: a find the request forgot
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
 * effect; each guard read applies its effects (applyLogin,
 * applyBearerEffects, renderCaller), so a guard answers as if it resolved
 * the login itself. A failed find is not kept: the next read asks again.
 *
 * The gate makes one for each routed request and binds it on the caller
 * (resolveHttpLogin); requestLogins() reads it. Outside a routed request
 * (a test calling a handler, a script) each read makes a fresh one: each
 * guard resolves on its own.
 */
export class RequestLogins {
  #login: Promise<FoundLogin> | null = null;
  #bearer: Promise<FoundBearer> | null = null;
  #render: Promise<{ user: SessionUser; nodeId: string } | null> | null = null;
  readonly #owner = new Map<string, Promise<SessionUser | 'refused' | null>>();
  readonly #member = new Map<string, Promise<MemberCaller | null>>();
  readonly #loginAsset = new Map<string, Promise<Resolved | null>>();
  #changed = false;
  /** The gate's failed find, kept for the first guard read (keepFailure). */
  #failure: Promise<FoundLogin> | null = null;
  /** The guard's answer the pipeline gave before the handler
   *  (answerRouteCaller), which the row's reader reads
   *  (ownerCaller(), memberCaller(), anyLoginCaller(), chatCaller()). */
  #answered: PipelineAnswer | null = null;
  /** The found login whose effects the gate applied before its Admin step
   *  (enterRouteLogin), until a read takes them. */
  #applied: FoundLogin | null = null;

  /** Whether the request changed a login since the gate resolved it
   *  (forget): the gate's Admin view of the row's area is then not read. */
  get changed(): boolean {
    return this.#changed;
  }

  /** Drop every login found so far: the request ended a login's sessions
   *  or changed its role or switch, so the next guard read finds each
   *  credential afresh. Already-applied effects stay applied. */
  forget(): void {
    this.#login = null;
    this.#bearer = null;
    this.#render = null;
    this.#owner.clear();
    this.#member.clear();
    this.#loginAsset.clear();
    this.#failure = null;
    this.#applied = null;
    this.#changed = true;
  }

  /** The gate's find of the login failed (the database): the first guard
   *  read is answered with that failure instead of asking again, so a
   *  request looks the login up once. A read after that one asks again. */
  keepFailure(failed: Promise<FoundLogin>): void {
    this.#failure = failed;
  }

  /** The gate applied `found`'s effects (enterRouteLogin): the first read
   *  of it takes them as applied (takeApplied). */
  markApplied(found: FoundLogin): void {
    this.#applied = found;
  }

  /** Whether the gate applied `found`'s effects and no read took them
   *  yet; the first read takes them, a later one applies them again. */
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

  loginAsset(url: string): Promise<Resolved | null> {
    return RequestLogins.#kept(this.#loginAsset, url, findLoginAsset);
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
/** The key of the login that view is of (the guard's login: the request's
 *  own, or on an asset row the one its asset guard answers as). */
const HTTP_ADMIN_FOR = 'httpAdminFor';

/** The request's logins, as the gate bound them on the caller; a fresh set
 *  outside a routed request (and inside a call nested in one with a caller
 *  of its own), where each guard resolves on its own. */
function requestLogins(): RequestLogins {
  return boundLogins(currentCaller()) ?? new RequestLogins();
}

/**
 * The request changed a login: its sessions ended
 * (endLoginSessions), its role or disabled switch changed (updateLogin), or
 * a key or device token it may have come in on was revoked. The request's
 * logins forget what they found, so a later guard read in the same request,
 * or work it started and did not await, finds the login afresh and sees the
 * change. Any login, not only the request's own: finding again costs one
 * read on these rare paths. A revoked key is the exception: findKeyLogin reads the gate's grant and never
 * checks the key again, so the login a key resolved to is found again for
 * the rest of the request. No-op outside a routed request.
 */
export function forgetRequestLogins(): void {
  boundLogins(currentCaller())?.forget();
}

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
  /** What the login the row's guard answers as holds of the row's Admin
   *  area (the Admin step's answer: the gate's step 5 holds every area row
   *  to it), for an Admin login on a row that manages an area;
   *  else null (a member, no login, a row with no area). */
  admin: AdminView | null;
  /** The facts the caller carries: the logins and the Admin view, under
   *  their keys. */
  facts: Readonly<Record<string, unknown>>;
}>;

/**
 * The gate's step 1 for a routed request: the request's
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
  // A frame document's row (route-policy.ts findsNoLogin, the frame caller):
  // opened by the `?t=` frame ticket the gate admitted, its handler reads
  // the login the ticket names (frameTicketCaller()), so nothing would
  // read one found here.
  if (row.public || findsNoLogin(row)) return none;
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
  // The Admin step's answer on a row that manages an area (the gate's step
  // 5 checks the area, not the guard): requireArea's,
  // for the login the row's guard answers as: the request's Admin login,
  // or on an asset row the one its asset guard answers as (assetViewLogin).
  // The view holds the row's area or nothing; a login without it is
  // refused ('area', whether or not it is in the Admin workspace: the
  // guard's rule) by step 5 (httpCaller, every area row's caller). A read
  // that fails is the request's failure, answered in the handler's place
  // (RouteLoginError): never a pass, never asked again by the guard.
  // (A row whose caller the gate does not answer, caller null, is a test's
  // stand-in route only, the boot refuses one in the app: its view is read
  // as the asset guard would, which is the session's Admin login first.)
  const adminId = res?.admin ? res.user.actor.id : null;
  const viewFor = row.area
    ? row.caller === 'ownerAsset' || row.caller === null
      ? await assetViewLogin(row, logins, adminId)
      : adminId
    : null;
  let admin: AdminView | null = null;
  if (row.area && viewFor) {
    let holds: boolean;
    try {
      holds = await loginHoldsArea(viewFor, row.area);
    } catch (error) {
      throw new RouteLoginError(error);
    }
    admin = { holdsAdmin: true, areas: new Set(holds ? [row.area] : []) };
  }
  const view = admin ? { [HTTP_ADMIN]: admin, [HTTP_ADMIN_FOR]: viewFor } : {};
  if (!res) {
    return admin ? { ...none, admin, facts: Object.freeze({ ...none.facts, ...view }) } : none;
  }
  return {
    logins,
    loginId: res.loginId,
    role: displayRole(res.admin),
    mode: found.mode,
    admin,
    facts: Object.freeze({ [HTTP_LOGINS]: logins, ...view }),
  };
}

/**
 * The login an asset row's guard answers as (getOwnerForAsset, in its
 * order: the session's Admin login, `adminId`, a valid `?at=` asset token's, the render
 * cookie's on a byte route a render page loads), found with no effect, as
 * the guard finds it (the same kept finds: RequestLogins); null where the
 * guard refuses (no credential it takes, a token it refuses). The gate's
 * Admin step holds the row's area for this login.
 */
async function assetViewLogin(
  row: RouteRow,
  logins: RequestLogins,
  adminId: string | null,
): Promise<string | null> {
  if (adminId) return adminId;
  const req = assetRequest(row);
  const url = new URL(req.url);
  try {
    // A GET only, as ownerForAsset reads the token.
    if (req.method === 'GET' && url.searchParams.get('at')) {
      const asset = await logins.ownerAsset(req.url);
      if (asset === 'refused') return null;
      if (asset) return asset.actor.id;
    }
    if (req.method === 'GET' && isRenderAssetPath(url.pathname)) {
      const render = await logins.render();
      if (render) return render.user.actor.id;
    }
  } catch (error) {
    throw new RouteLoginError(error);
  }
  return null;
}

// ── The caller the pipeline answers ─────────────────────────────────────────

/**
 * The login's effects failed before the gate's Admin step (enterRouteLogin:
 * the database, stamping a device token). Thrown out of enterCall for the
 * gate middleware, which answers the error it carries in the handler's
 * place (onError, with the gate's CORS headers).
 */
export class RouteLoginError extends Error {
  constructor(readonly error: unknown) {
    super('the request login could not be applied');
    this.name = 'RouteLoginError';
  }
}

/**
 * The gate's step before its Admin step, on a row
 * whose handler reads the pipeline's caller and whose Admin step the gate
 * enforces (an Admin login on an area row: the HTTP caller's `admin`): the
 * login's effects applied in the request slot, before step 5 refuses or
 * lets it through, as the owner guard applies them before its area check:
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
    // TODO: fold the markApplied/takeApplied handshake into the gate once
    // no guard is left (the gate applies the effects, once).
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
  | Readonly<{ caller: 'chat'; chat: ChatCaller }>
  | Readonly<{ caller: 'session'; user: SessionUser | null }>
  | Readonly<{ caller: 'ownerAsset'; user: SessionUser }>
  | Readonly<{ caller: 'readerAsset'; reader: AssetReader }>
  | Readonly<{ caller: 'loginAsset'; login: Login }>
  | Readonly<{ caller: 'frame'; ticket: AppFrameTicket | null }>
  | Readonly<{
      caller: 'publicLogin';
      atRead: AtRead<Login | NextResponse | RouteRefusal, { audit: boolean }>;
    }>
  | Readonly<{ caller: 'cookieUpgrade'; atRead: AtRead<CookieUpgradeLogin | NextResponse, null> }>
  | Readonly<{ caller: 'ownerAtRead'; atRead: AtRead<SessionUser | NextResponse, null> }>;

/** What getReaderForAsset answers when it lets a login through: the Admin
 *  user (or the member's view of the anchor), and the member, null for an
 *  Admin user. */
export type AssetReader = { user: SessionUser; member: MemberCaller | null };

/**
 * An answer the gate binds for the handler's first read to run
 * (route-policy.ts ANSWERED_AT_READ): the guard of the row's kind, run
 * once, in the handler's own place, so whatever the handler does first
 * still comes first and the effects of the answer (a device token's stamp,
 * the actor named, an audit row) fall at the read. Every later read is the same answer. A read with other
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
 * The refusal of an answer taken at the read (ownerCallerAtRead): thrown
 * out of the handler and answered by the app's onError as it is
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
 * (getMemberOr401): the member named, its scope entered
 * or its own rule noted, a key's write audited. The any-login guard
 * (getLoginOr401) and the chat guard (getChatLoginOr401): the login named,
 * its scope entered or the system reason noted (anyLoginScope), the audit
 * row each role's own gate writes. The asset guards on
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
 * The login a row's login limit counts (route-limits.ts), from the answer
 * the pipeline gave (answerRouteCaller): the owner guard's login (a
 * member's own id where a member called; an Admin user's actor), the member, the any-login and chat logins, a byte
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
    case 'loginAsset':
      return { loginId: answer.login.loginId, member: !loginAdminPair(answer.login) };
    case 'chat':
      return { loginId: answer.chat.loginId, member: !loginAdminPair(answer.chat.asLogin) };
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
  const url = new URL(req.url);
  const t = url.searchParams.get('t');
  if (!t) return null;
  // A canvas frame takes a canvas's ticket only, every other frame an app's.
  return CANVAS_FRAME_PATH.test(url.pathname)
    ? verifyCanvasFrameTicket(t)
    : verifyAppFrameTicket(t);
}

/** The Present canvas frame document (its route declares `caller: 'frame'`). */
const CANVAS_FRAME_PATH = /^\/api\/presents\/[^/]+\/frame$/;

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
      // The any-login answer writes the generic api.write row of its rows;
      // a gone stub writes none.
      const login = await getLoginOr401({ audit: !row.gone });
      return login instanceof NextResponse ? login : { caller, login };
    }
    case 'chat': {
      const chat = await getChatLoginOr401();
      return chat instanceof NextResponse ? chat : { caller, chat };
    }
    case 'session':
      // Any Admin user, or null: never a refusal, the handler answers a
      // null (the rows open to every Admin user: their declaration's
      // `caller: 'session'`).
      return { caller, user: await getSessionUser() };
    case 'ownerAsset': {
      const user = await getOwnerForAsset(assetRequest(row));
      return user instanceof NextResponse ? user : { caller, user };
    }
    case 'readerAsset': {
      const reader = await getReaderForAsset(assetRequest(row));
      return reader instanceof NextResponse ? reader : { caller, reader };
    }
    case 'loginAsset': {
      const login = await getLoginForAsset(assetRequest(row));
      return login instanceof NextResponse ? login : { caller, login };
    }
    case 'frame': {
      // The ticket only: the handler checks it names this app and that its
      // login is still active.
      const req = getRequestContext()?.req;
      if (!req) throw new Error(`answerRouteCaller: ${row.key} has no request`);
      return { caller, ticket: frameTicketOf(req) };
    }
    case 'publicLogin':
      // A login limit of the row (route-limits.ts) is taken here, at the
      // read: no login spends nothing, and what the handler checks first
      // still comes first. Over the limit, the read throws the one 429.
      return {
        caller,
        atRead: new AtRead(async (opts) => {
          const got = await getLoginOr401(opts);
          if (got instanceof NextResponse) return got;
          if (!row.rateLimit.length) return got;
          const req = getRequestContext()?.req;
          if (!req) throw new Error(`answerRouteCaller: ${row.key} has no request`);
          const over = takeRouteLimits(row.rateLimit, {
            req,
            login: { loginId: got.loginId, member: !loginAdminPair(got) },
            scopes: LOGIN_SCOPE,
          });
          return over ? new RouteRefusal(over) : got;
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
 * the owner guard's user (getOwnerOr401WithLogin), read from the bound
 * caller, with no lookup
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
 * The owner guard's owner and how the request authenticated, read from
 * the pipeline's answer as ownerCaller() reads it: no lookup, no effect, and the same throw where the pipeline answered
 * no owner. A handler reads it in place of the guard:
 *
 *     const { user, source } = ownerCallerWithSource();
 */
export function ownerCallerWithSource(): { user: SessionUser; source: AuthSource } {
  const { owner } = pipelineAnswer('ownerCallerWithSource', 'owner');
  return { user: owner.user, source: owner.source };
}

/**
 * The login of an owner row as the Login itself:
 * the Admin user's or the member's, the very object the owner guard
 * answered with, so adminFacts(login) asks its scope. No lookup, no
 * effect, and the same throw as ownerCaller() where the pipeline answered
 * no owner. A handler that decides Admin reads this and asks adminFacts.
 *
 *     const login = ownerLoginCaller();
 *     const { admin } = await adminFacts(login);
 */
export function ownerLoginCaller(): Login {
  const login = ownerAnswerLogin(pipelineAnswer('ownerLoginCaller', 'owner').owner);
  if (!login) throw new Error('ownerLoginCaller(): the owner answer carries no login');
  return login;
}

/** The Login of an owner answer getOwnerOr401WithLogin gave (the very
 *  object), else null: what ownerLoginCaller() reads. */
export function ownerAnswerLogin(owner: OwnerRouteLogin): Login | null {
  return ownerLogins.get(owner) ?? null;
}

/**
 * The member the pipeline answered for this request:
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
 * The login the pipeline answered for this request on an any-login route
 * (the any-login list), as the Login itself: the very object
 * getLoginOr401 answered, so adminFacts(login)
 * asks its scope. No lookup, no effect, and a throw where the pipeline
 * answered no login. A handler that decides Admin reads this and asks
 * adminFacts.
 *
 *     const login = anyLoginCaller();
 *     const { admin } = await adminFacts(login);
 */
export function anyLoginCaller(): Login {
  return pipelineAnswer('anyLoginCaller', 'login').login;
}

/**
 * The chat login the pipeline answered for this request: what
 * getChatLoginOr401 answers, on a chat or Telegram chat route, with
 * its Login (`asLogin`): what the chat helpers take, asking
 * adminFacts(caller.asLogin) whether it is an Admin user. Read from the
 * pipeline's answer as ownerCaller() reads the owner: no lookup, no
 * effect, and a throw where the pipeline answered no chat login. A handler
 * reads it in place of the guard:
 *
 *     const login = chatCaller();
 */
export function chatCaller(): ChatCaller {
  return pipelineAnswer('chatCaller', 'chat').chat;
}

/**
 * The session user the pipeline answered for this request: what
 * getSessionUser answers, any Admin user or null (a member, no
 * login), on a row open to every Admin user (its declaration's
 * `caller: 'session'`), read from the pipeline's answer as ownerCaller() reads
 * the owner: no lookup, no effect, and a throw where the pipeline answered
 * no session user. The gate refuses nothing for it: the handler answers a
 * null.
 *
 *     const user = sessionUserCaller();
 *     if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
 */
export function sessionUserCaller(): SessionUser | null {
  return pipelineAnswer('sessionUserCaller', 'session').user;
}

/**
 * The Admin user (or a member's view) the pipeline answered for a byte
 * route: what getOwnerForAsset answers, its session, a
 * `?at=` asset token or the render cookie, read from the pipeline's answer
 * as ownerCaller() reads the owner: no lookup, no effect, and a throw where
 * the pipeline answered none.
 */
export function ownerAssetCaller(): SessionUser {
  return pipelineAnswer('ownerAssetCaller', 'ownerAsset').user;
}

/**
 * Who reads a byte route of brain items: what
 * getReaderForAsset answers, an Admin user (`member` null) or a member on a
 * read open to it, read from the pipeline's answer as ownerCaller() reads
 * the owner.
 */
export function readerAssetCaller(): AssetReader {
  return { ...pipelineAnswer('readerAssetCaller', 'readerAsset').reader };
}

/**
 * Any login on a byte route of an any-login row (a person's photo): what
 * getLoginForAsset answers, its session or
 * its own `?at=` asset token, read from the pipeline's answer as
 * anyLoginCaller() reads it.
 */
export function anyLoginAssetCaller(): Login {
  return pipelineAnswer('anyLoginAssetCaller', 'loginAsset').login;
}

/**
 * The frame ticket a sandbox frame document was opened with: the `?t=` the
 * gate admitted, verified (verifyAppFrameTicket), or null.
 * No login is resolved for these rows; the handler checks the ticket names
 * its app and that its login is still active.
 */
export function frameTicketCaller(): AppFrameTicket | null {
  return pipelineAnswer('frameTicketCaller', 'frame').ticket;
}

/**
 * The login a public row reads, as the Login itself: what getLoginOr401
 * answers, taken at this read, after the handler's own checks (the
 * cross-site refusal, the body, the remote MCP switch and the client's
 * validation), so adminFacts(login) asks about it (a public row enters no
 * scope: the row's answer). Never a refusal: no login is null, and the
 * handler answers it (unauthorizedRefusal(), its own words, or
 * carrying on). `audit`: the generic api.write row of a write, as the
 * guard's `audit` (POST /api/auth/pair). The first read runs the answer; a
 * later one is the same answer.
 *
 *     const login = await publicLoginItself();
 *     if (!login) return unauthorizedRefusal();
 */
export async function publicLoginItself(opts: { audit?: boolean } = {}): Promise<Login | null> {
  const atRead = pipelineAnswer('publicLoginItself', 'publicLogin').atRead;
  const got = await atRead.take({ audit: opts.audit === true });
  // Over the row's login limit: the one 429, answered by the app.
  if (got instanceof RouteRefusal) throw got;
  return got instanceof NextResponse ? null : got;
}

/** What getCookieUpgradeLoginOr401 answers when it lets a login through. */
export type CookieUpgradeLogin = Exclude<
  Awaited<ReturnType<typeof getCookieUpgradeLoginOr401>>,
  NextResponse
>;

/**
 * The login POST /api/auth/sso turns into a session cookie: what
 * getCookieUpgradeLoginOr401 answers (the device token only), taken at
 * this read, after the route's throttle and origin check. Null where it
 * refused (no device token).
 */
export async function cookieUpgradeCaller(): Promise<CookieUpgradeLogin | null> {
  const got = await pipelineAnswer('cookieUpgradeCaller', 'cookieUpgrade').atRead.take(null);
  return got instanceof NextResponse ? null : { ...got };
}

/**
 * The owner of a row whose handler runs checks of its own before it reads
 * the owner (PATCH /api/pages/:id, whose /api/v1 wrapper holds an API key
 * to its rules first): the owner guard's user, taken at this read, with
 * its effects (the item a write names checked, the audit row). A refusal
 * is thrown (RouteRefusal) and answered by the app: the handler goes no
 * further and cannot answer in its place.
 */
export async function ownerCallerAtRead(): Promise<SessionUser> {
  const got = await pipelineAnswer('ownerCallerAtRead', 'ownerAtRead').atRead.take(null);
  if (got instanceof NextResponse) throw new RouteRefusal(got);
  return got;
}

/** The 401 a session guard answers no login with (`unauthorized`, the one
 *  mapper): what a handler answers a null public login with. */
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
  loginAsset: 'asset login',
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

/**
 * Whether `loginId` holds `area`, for the guard: the gate's Admin view of
 * the row's area, the one resolveHttpLogin read and the gate's step 5 held
 * the row to, where it answers this read; else the area asked again
 * (loginHoldsArea). The view does not
 * answer a read for another login than the view's, after the request
 * changed a login (forgetRequestLogins), or with no view (a test's stand-in
 * route). A view mismatch is never a refusal of its own: only a failed
 * area read fails closed, thrown here as in the gate.
 */
async function guardHoldsArea(
  loginId: string,
  area: import('@mantle/client-types').WorkspaceArea,
): Promise<boolean> {
  const caller = currentCaller();
  const logins = boundLogins(caller);
  const view =
    logins && !logins.changed ? (caller?.facts?.[HTTP_ADMIN] as AdminView | undefined) : undefined;
  if (view && caller?.facts?.[HTTP_ADMIN_FOR] === loginId) return view.areas.has(area);
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
  return res?.admin ? { user: res.user, source: res.source } : null;
}

/** Returns the current ADMIN user, or null (a member is null too). Safe in
 *  Server Components. Resolves a session cookie first; falls back to a mobile
 *  bearer token so every handler that already calls this also accepts the
 *  mobile companion. */
export async function getSessionUser(): Promise<SessionUser | null> {
  return (await getSessionUserWithSource())?.user ?? null;
}

/** Control-flow login redirect: the Hono app's onError turns a
 *  RedirectError into a real 307. */
function redirect(to: string): never {
  throw new RedirectError(to);
}

/**
 * Gate for the render surfaces (/print/pages, /print/draws, /render/draws).
 * An admin session opens them; otherwise the render cookie the
 * browser sidecar carries, and only for the node that cookie names. Redirects
 * to /login.
 */
export async function requireOwnerForRender(nodeId: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user) return user;
  const render = await renderCaller();
  if (render && render.nodeId === nodeId) return render.user;
  // A render cookie that is refused (forged, expired, for another node, or
  // for a login that is no Admin user now) answers 403: a sidecar that
  // followed the login redirect would print the sign-in page as the
  // document (the documents engine fails its job on 403; the browser sidecar
  // reads the status too). A request with no render cookie is a person: the
  // login page.
  if ((await cookies()).get(RENDER_COOKIE_NAME)?.value) throw new RenderCookieRefusedError();
  redirect('/login');
}

/** The render surfaces' refusal of a render cookie (403, no redirect). */
export class RenderCookieRefusedError extends Error {
  constructor() {
    super('the render cookie does not open this node');
    this.name = 'RenderCookieRefusedError';
  }
}
defineDomainError(RenderCookieRefusedError, {
  reason:
    'a render sidecar sent a render cookie the surface refuses; the job must fail, not print the login page',
  status: 403,
});

/**
 * Audit hook of the session guards (the owner guard, the member, any-login
 * and chat guards, the cookie upgrade), which the gate runs for every row
 * that reads a caller. For a write (learned from the middleware-injected
 * x-mantle-method/-path headers, which clients can't spoof, and the routed
 * request's row: auditsAsWrite) it fire-and-forgets a generic `api.write`
 * row recording who did what — unless the route logs its own richer event
 * (its row's `audit: 'own'`, the route file's declaration). Reads aren't logged; a GET whose row is a
 * write (a connector's OAuth callback, an effect exception) is.
 */
async function auditMutation(user: SessionUser, skip?: (path: string) => boolean): Promise<void> {
  const h = await headers();
  const method = (h.get(MANTLE_METHOD_HEADER) ?? '').toUpperCase();
  const path = h.get(MANTLE_PATH_HEADER) ?? '';
  const route = currentRoute();
  const mutating = auditsAsWrite(method, route?.effect ?? null);
  // A route that logs its own richer event: its row says so (`audit: 'own'`,
  // its declaration).
  if (!mutating || route?.audit === 'own' || skip?.(path)) return;
  // A write made with an API key names the key (never its secret).
  const key = getRequestContext()?.accessKey;
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'api.write',
    method,
    path,
    // The proxy-appended address, not the caller's leftmost.
    ...(await requestMeta()),
    // The key's maker too: a key that acts as a member logs its
    // writes under that login, and the maker is who to ask.
    ...(key
      ? { detail: { keyId: key.id, keyPrefix: key.prefix, keyCreatedBy: key.createdBy } }
      : {}),
  });
}

/** What getOwnerOr401WithLogin answers: the brain handle, how the request
 *  authenticated, and `member` set exactly when the login is not an Admin
 *  user (a member on an owner route open to it). Its Login is
 *  ownerAnswerLogin(answer). */
export type OwnerRouteLogin = Readonly<{
  user: SessionUser;
  source: AuthSource;
  member: MemberCaller | null;
}>;

/**
 * The owner guard (the gate runs it for an owner row, answerRouteCaller;
 * a handler reads ownerCaller() and its projections): the
 * owner, how the request authenticated ('web' cookie, 'mobile' bearer,
 * 'api' key), and WHO the login is: `member` set for a login that is not
 * an Admin user, on an owner route open to it (the app runner routes run a
 * member at the team rules, an Admin user at the app's). A refusal is a 401
 * JSON response, never a redirect: a revoked or expired bearer slips past
 * the stateless gate check and is caught here.
 */
export async function getOwnerOr401WithLogin(): Promise<OwnerRouteLogin | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  if (!res.admin) {
    // A member reaches an owner route to read brain items in its
    // own scope (its row's `open: 'owner'`; drafts where it may edit), or
    // to create, edit and delete them there (the same); every
    // other owner route refuses it (member routes use getMemberOr401; the
    // sweeps check both).
    const route = guardRoute();
    if (route === UNROUTED) return unroutedRefusal();
    if (route === OUTSIDE) return loginRefused(false);
    const who: OwnerRouteLogin = { user: res.user, source: res.source, member: memberOf(res) };
    noteOwnerLogin(who, answeredLogin(res));
    if (memberOpenRead(route)) {
      await enterLoginScope(res.loginId, requestMode(true));
      return who;
    }
    if (!memberOpenWrite(route)) return loginRefused(false);
    const refused = await enterLoginWrite(res.loginId, route, { admin: false });
    if (refused) return refused;
    await auditMutation(res.user);
    return who;
  }
  const refused = await adminRouteGate(res.user.actor.id);
  if (refused) return refused;
  await auditMutation(res.user);
  const who: OwnerRouteLogin = { user: res.user, source: res.source, member: null };
  noteOwnerLogin(who, answeredLogin(res));
  return who;
}

/** The Login of each owner answer getOwnerOr401WithLogin gave (keyed on the
 *  very answer, which the pipeline keeps): what ownerLoginCaller() reads,
 *  so a handler asks adminFacts(login). */
const ownerLogins = new WeakMap<OwnerRouteLogin, Login>();
/** The same Login, keyed on the answer's very user object (what
 *  ownerCaller() hands a handler): ownerUserLogin. */
const ownerUserLogins = new WeakMap<SessionUser, Login>();

function noteOwnerLogin(who: OwnerRouteLogin, login: Login): void {
  ownerLogins.set(who, login);
  ownerUserLogins.set(who.user, login);
}

/**
 * The Login of the owner a handler read with ownerCaller(), from that very
 * user object: a projection of what the handler already read, never a read
 * of the pipeline, so a helper the handler passes its user to can ask
 * adminFacts(login). Null for a user no owner answer gave (a copy, a
 * stand-in): the helper answers as for a login without the facts.
 */
export function ownerUserLogin(user: SessionUser): Login | null {
  return ownerUserLogins.get(user) ?? null;
}

// ── The request scope ───────────────────────────────────────────────────────

/** No request slot: a test calling a handler, a worker (guardRoute). */
const OUTSIDE = 'outside';
/** A request slot with no ROUTE_POLICY row (guardRoute). */
const UNROUTED = 'unrouted';

/**
 * The ROUTE_POLICY row a session guard serves:
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
  return requireArea({ loginId, anchorId }, area);
}

/**
 * What an Admin login's owner request runs as: a management route
 * needs its area and runs on the system pool; the login's own things run
 * there too; a read or a write of brain items enters the login's scope
 * (a write as a member's: enterLoginWrite).
 * Outside a request slot (a test calling a handler) nothing changes; a
 * request slot with no row is refused (guardRoute). Returns the refusal,
 * or null to go on.
 */
async function adminRouteGate(loginId: string): Promise<NextResponse | null> {
  const route = guardRoute();
  if (route === UNROUTED) return unroutedRefusal();
  if (route === OUTSIDE) return null;
  const cls = route.scope;
  // The gate's refusals, answered by the one mapper: no route
  // class is step 3 (no policy), an area the login lacks step 5.
  if (!cls) return accessRefusal(new AccessError('unclassified'));
  if (cls.kind === 'area') {
    // The gate's step 5 refused a login without the row's area (every area
    // row's caller, route-policy.ts ADMIN_STEP_CALLERS). The guard reads the
    // view the gate held it to; a read that view does not answer asks the
    // area again (guardHoldsArea).
    if (!(await guardHoldsArea(loginId, cls.area))) {
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
 * A login's write request to brain items, a member's or an Admin user's:
 * the create home recorded (createHomeFor: an Admin user without ?ws=
 * creates in the folder's home else Admin; a member's private workspace is
 * its fallback), then the request runs in the login's scope for the rest
 * of the request, reads and writes alike: its reads on the workspace role,
 * its writes through the login write gateway (loginWriteRoute: the write
 * role while the actor check is warn or on, where the database's write and
 * edit checks answer for every statement). An Admin user's Admin rights
 * are in that scope (the Admin workspace and its limits:
 * mantle_scope_has_admin, mantle_scope_has_area), so the database answers
 * for them too. Returns the refusal, or null to go on.
 *
 * No write is kept on the system pool: the Admin acts
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
  // The item a route names is checked once, in the database, in the
  // login's scope: no route has a TypeScript pre-check (a declared item
  // states intent only, route-declaration.ts).
  // A create lands in the request's workspace (?ws=) when the login
  // moderates it; else by the login's default home rule.
  const home = await createHomeFor(loginId, route, !opts.admin);
  if (home instanceof NextResponse) return home;
  noteRequestCreateHome(home);
  await enterLoginScope(loginId, requestMode(true));
  return null;
}

/**
 * Where a create through `method pattern` lands, or a refusal. `?ws=<id>` names the request's workspace: a login that
 * is not in it is refused (403 workspace); one that moderates it creates
 * there; one that only reads it creates as if it had not named one. For a
 * non-Admin login (`ownWork`) the private workspace is the fallback (made
 * now when it has none): the folder it creates in when it may edit that,
 * else its private workspace, never Admin. An Admin user without ?ws=
 * creates in the folder's home, else Admin. Not a create: nothing to record (null createWs, and
 * the private workspace only for a non-Admin login's other writes, which
 * may make an item too, such as a commit that makes a copy).
 */
async function createHomeFor(
  loginId: string,
  route: RouteRow,
  ownWork: boolean,
): Promise<CreateHome | NextResponse> {
  // THE create-home intent: @mantle/db createHomeIntent, shared
  // with assistant turns and MCP.
  const home = await createHomeIntent(
    ...requestCreateHomeArgs(loginId, route, getRequestContext()?.req?.url ?? null, ownWork),
  );
  if ('refused' in home) {
    // Answered by the one mapper: 400 invalid, else 403 workspace.
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
 * makes the private workspace: its existing one, if any, else none. Any
 * other write may make it: a create, and also an edit, a move or a copy
 * (such a write may land a new item, and with no private workspace named
 * its home would fall back to the folder's home else Admin, so it is not
 * narrowed to the create routes). create-home-parity.test.ts pins the gate's step 6 with the same
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
 *  (@mantle/std mapAccessError), the bodies the guards send. */
function accessRefusal(err: AccessError): NextResponse {
  const { status, body } = mapAccessError(err)!.http!;
  return NextResponse.json(body, { status });
}

/** The 403 a gate answers a login on a route not open to it with. The
 *  reason names what the CALLER is: `member-login` (not an Admin user), or
 *  `admin-login` (an Admin user on a member route). */
export function loginRefused(admin: boolean): NextResponse {
  const body = admin
    ? { reason: 'admin-login', message: 'This route is for member logins.' }
    : { reason: 'member-login', message: 'Not available to member logins.' };
  return NextResponse.json({ error: 'forbidden', ...body }, { status: 403 });
}

/**
 * The member gate: a MEMBER login, or 401 (no
 * session) / 403 (an admin: member routes are member-specific, never a
 * shared owner route). Only for the member routes (their declaration's
 * `open: 'member'`); run the handler's reads under
 * `withViewer(…)`.
 */
export async function getMemberOr401(): Promise<MemberCaller | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  // A member and nothing else: an Admin user gets admin-login.
  if (res.admin) return loginRefused(true);
  // A write made with an API key is always on the trail, whoever the key
  // acts as; a member's own session writes are not audited here.
  if (res.source === 'api') await auditMutation(res.user);
  // A member route that reads brain items runs in the login's request
  // scope; one about the login's own things holds its own rule.
  return (await memberRouteScope(res.loginId)) ?? memberOf(res);
}

/**
 * Is this member login still allowed in? For work that outlives the
 * request that authenticated it, such as an open realtime stream: the row
 * is re-read, so a disabled login, or one added to Admin (memberLogin),
 * ends it.
 */
export async function memberLoginActive(loginId: string): Promise<boolean> {
  const row = await loadLoginRow(loginId);
  return !!row && memberLogin(row);
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
 * /api/auth/pair), by the rule each guard follows: an Admin user's write
 * always, a member's write when it was made with an API key. Reads are not
 * logged, and a path that logs its own richer event is skipped
 * (auditMutation). Written inside the guard, as the member and chat guards
 * write theirs.
 */
async function auditLoginMutation(res: Resolved): Promise<void> {
  if (res.admin || res.source === 'api') await auditMutation(res.user);
}

/** What the session guards knew of each Login they answered beyond the
 *  Login: the row's Admin answer, with the login id it was found for. Keyed
 *  on the very object (frozen), so a Login built anywhere else has none
 *  (adminFacts then answers no), and the entry answers only while the object
 *  still names that login. */
const loginFacts = new WeakMap<Login, Readonly<{ loginId: string; admin: boolean }>>();

/**
 * The row's Admin answer for a Login the session guards answered: a user of
 * the live Admin workspace now (adminLogin, read with the login row; the
 * role is not asked). adminFacts needs it, then asks the login's own scope
 * (mantle_scope_admin_facts, membership again in SQL) or, with no scope
 * open, takes the row's areas. False for a Login they did not answer.
 */
export function loginAdminPair(login: Login): boolean {
  const got = loginFacts.get(login);
  return !!got && got.loginId === login.loginId && got.admin;
}

/** The calling login's own row, whatever its role: for the few routes about
 *  the login itself (change its password, sign out, who am I). Never for
 *  brain data. Whether it is an Admin user is adminFacts(login).
 *  `sessionEpoch` is the epoch the credential was verified at, for work that
 *  must still be that session's when it lands (OAuth consent).
 *  `audit`: write the generic api.write row of a write once the login is
 *  let through (auditLoginMutation): the any-login rows (the answer step)
 *  and POST /api/auth/pair ask for it; the routes about the login's own
 *  session (sign out, change password, OAuth consent) write none. */
export async function getLoginOr401(opts: { audit?: boolean } = {}): Promise<Login | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  const refused = await anyLoginScope(res);
  if (refused) return refused;
  const login = answeredLogin(res);
  if (opts.audit) await auditLoginMutation(res);
  return login;
}

/**
 * The any-login guard of a byte route an <img> src opens (a person's
 * photo in the desktop app and the phone,
 * which send no cookie and whose <img> carries no bearer): the request's
 * login as getLoginOr401 finds it (cookie, device token), else on a GET
 * the `?at=` asset token the login's shell mints for its byte srcs, the
 * same token and lifetime /api/profile/photo takes (buildAssetToken;
 * findLoginAsset re-reads its login). Its actor is named read-only and its
 * scope entered as the any-login guard enters it (anyLoginScope). No audit
 * row: a byte read. The gate admits the token on the asset paths alone
 * (isAssetPath), and ROUTE_POLICY reads this kind on a GET or HEAD of
 * those only.
 */
export async function getLoginForAsset(req: Request): Promise<Login | NextResponse> {
  const res = await resolveLogin();
  const found = res ?? (req.method === 'GET' ? await requestLogins().loginAsset(req.url) : null);
  if (!found) return accessRefusal(new AccessError('unauthorized'));
  if (!res) nameRequestLogin(found, 'ro');
  const refused = await anyLoginScope(found);
  if (refused) return refused;
  return answeredLogin(found);
}

/** The Login of a resolved caller, frozen (its actor a frozen copy), with
 *  the row's Admin answer kept for it (loginAdminPair, adminFacts): what
 *  getLoginOr401 (and the owner and chat guards) answer. */
function answeredLogin(res: Resolved): Login {
  const login: Login = Object.freeze({
    loginId: res.loginId,
    brainId: res.user.id,
    email: res.user.actor.email,
    displayName: res.user.actor.displayName,
    contactId: res.contactId,
    source: res.source,
    sessionEpoch: res.epoch,
    actor: Object.freeze({ ...res.user.actor }),
  });
  loginFacts.set(login, Object.freeze({ loginId: login.loginId, admin: res.admin }));
  return login;
}

/**
 * Who calls a chat route (/api/assistant/*): any login, for
 * its own threads only. `user` keeps the owner-route shape (`id` is the
 * brain's anchor, `actor` the login), so the chat helpers take one shape;
 * `asLogin` is the very Login the chat guard answered, so a chat helper
 * asks adminFacts(caller.asLogin) whether it is an Admin user (a Login
 * carries no kind).
 */
export type ChatCaller = Readonly<{
  /** The brain (the anchor login's id). */
  ownerId: string;
  /** The login whose threads this request reads and writes. */
  loginId: string;
  source: AuthSource;
  user: SessionUser;
  displayName: string | null;
  email: string;
  asLogin: Login;
}>;

/**
 * The chat gate (an owner decision): every login chats
 * with the assistants of its workspaces, each in its own thread, and reads
 * only its own threads. The chat routes are any-login routes
 * (`open: 'chat'`): a read runs in the login's scope, where row security
 * holds the messages and threads to its own login (0269); every login's
 * write runs there too, an Admin user's as a member's (anyLoginScope).
 * Every chat helper also names the login (lib/assistant.ts,
 * lib/assistant-chat.ts), and the few writes and bookkeeping reads the
 * workspace role has no grant for leave the scope by name (asSystem
 * 'rule-in-query'). Audited as the any-login guard audits.
 */
export async function getChatLoginOr401(): Promise<ChatCaller | NextResponse> {
  const res = await resolveLogin();
  if (!res) return accessRefusal(new AccessError('unauthorized'));
  const refused = await anyLoginScope(res);
  if (refused) return refused;
  const asLogin = answeredLogin(res);
  await auditLoginMutation(res);
  return Object.freeze({
    ownerId: res.user.id,
    loginId: res.loginId,
    source: res.source,
    user: res.user,
    displayName: res.user.actor.displayName ?? null,
    email: res.user.actor.email,
    asLogin,
  });
}

/**
 * The request scope of getLoginOr401. On an any-login route
 * (`open: 'any'`: shell, workspaces, grants, access keys, whoami; the
 * chat and Telegram pairing routes) every login enters its scope, reads and
 * writes alike: an Admin user's write too (its keys, its chat threads and
 * Telegram pairings, the grants and workspaces writes). The grants and
 * workspace libraries read in the scope; the shell,
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
  await enterLoginScope(res.loginId, requestMode(res.admin));
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
  if (res.admin) await auditMutation(res.user);
  return {
    loginId: res.user.actor.id,
    email: res.user.actor.email,
    role: displayRole(res.admin),
    epoch: res.epoch,
    deviceJti,
  };
}

/**
 * A bcrypt hash (cost 12, same as every login) of a throwaway string. An
 * unknown email is compared against it, so a missing login costs the same
 * bcrypt time as a real one: the answer's timing does not say whether the
 * email has an account.
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
      ...passwordRuleColumns(),
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
  // Password sign-in is for admins and members (the only roles): a role
  // this code does not know never signs in.
  // Refused like a wrong password (no role oracle).
  const role: string = row.role;
  const passwordRole = isLoginRole(role);
  if (!(ok && passwordRole && loginUsable(row))) return null;
  await notePasswordChecked(row.id, password, {
    mustChangePassword: row.mustChangePassword ?? null,
    passwordCheckedMin: row.passwordCheckedMin ?? null,
  });
  return { id: row.id, sessionEpoch: row.sessionEpoch };
}

/**
 * The box password policy whenever a login's password is checked (a sign-in,
 * a password prompt; docs/policy.md): while it sets a password rule, the
 * login's must_change_password follows whether the password just taken
 * fails it (set: the request gate holds the login to the change-password
 * step, password-hold.ts; cleared: a rule lowered since lets it through),
 * and password_checked_min records the rule it was checked under. With no
 * rule: nothing is read or written, as before. Returns whether the login
 * must now change its password.
 */
async function notePasswordChecked(
  loginId: string,
  password: string,
  now: { mustChangePassword: boolean | null; passwordCheckedMin: number | null },
): Promise<boolean> {
  const min = passwordPolicyMin();
  if (min === null) return false;
  const needs = signInNeedsPasswordChange(password);
  if (needs !== now.mustChangePassword || now.passwordCheckedMin !== min) {
    await writeLoginCredential(loginId, { mustChangePassword: needs, passwordCheckedMin: min });
  }
  return needs;
}

/** A new login's password was set under the rule in force (signup, an
 *  invite accept, an Admin's new login: each took a password that meets
 *  it): record the rule, so the login is not asked to sign in again for
 *  it. With no rule: nothing written. */
export async function notePasswordSet(loginId: string): Promise<void> {
  const min = passwordPolicyMin();
  if (min === null) return;
  await writeLoginCredential(loginId, { mustChangePassword: false, passwordCheckedMin: min });
}

/** A login's credential columns (the password hash, the policy's forced
 *  change): never the narrow login's, the full-route spot login-credential
 *  on a narrow exit (docs/runtime-role.md). */
function writeLoginCredential(
  loginId: string,
  set: { passwordHash?: string; mustChangePassword?: boolean; passwordCheckedMin?: number | null },
): Promise<unknown> {
  return onFullSystemRoute('login-credential', () =>
    db.update(authUsers).set(set).where(eq(authUsers.id, loginId)),
  );
}

/** authenticatePassword, the login id only (the password bearer logins: an
 *  admin's or a member's bearer is a mobile_tokens row and carries no epoch). */
export async function loginWithPassword(email: string, password: string): Promise<string | null> {
  return (await authenticatePassword(email, password))?.id ?? null;
}

/** The one password hash every login is stored with (bcrypt, cost 12), and
 *  the one gate of every new password: one that fails the password rule in
 *  force (password-rule.ts; with no box policy, today's 8 characters) is
 *  refused here (PasswordRuleError, a 400), whichever writer asked. A route
 *  checks passwordProblem first for its coded answer; this is the backstop
 *  no writer can skip. */
export async function hashLoginPassword(password: string): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new PasswordRuleError(problem);
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

/** Update password hash. Caller is responsible for verifying the old password first.
 *  A credential column: never the narrow login's (the full-route spot
 *  login-credential on a narrow exit; docs/runtime-role.md). */
export async function updatePassword(userId: string, newPassword: string): Promise<void> {
  const hash = await hashLoginPassword(newPassword);
  // The new password met the rule in force (hashLoginPassword refused one
  // that does not): the forced change is done, and the login is checked
  // under that rule, or under none with no rule. Written with every new
  // password, rule or not: a password set while no rule is in force must
  // be checked when a rule comes back (docs/policy.md). On a box that
  // never had a rule both columns already hold these values.
  await writeLoginCredential(userId, {
    passwordHash: hash,
    mustChangePassword: false,
    passwordCheckedMin: passwordPolicyMin(),
  });
}

/**
 * A password prompt that grants something (a new API key, MCP consent):
 * verifyPassword, and the box password rule's check of the password just
 * typed (notePasswordChecked). 'held': the password is right but fails the
 * rule, so the login is now held to the change-password step and the
 * caller grants nothing (it answers the hold's 403). Not for the change
 * itself, whose old password may be the weak one.
 */
export async function verifyPasswordForUse(
  userId: string,
  password: string,
): Promise<'ok' | 'wrong' | 'held'> {
  const [row] = await db
    .select({ hash: authUsers.passwordHash, ...passwordRuleColumns() })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  if (!row?.hash || !(await bcrypt.compare(password, row.hash))) return 'wrong';
  const held = await notePasswordChecked(userId, password, {
    mustChangePassword: row.mustChangePassword ?? null,
    passwordCheckedMin: row.passwordCheckedMin ?? null,
  });
  return held ? 'held' : 'ok';
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

// ── Ending a login's sessions ────────────────────────────────────────────────

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
     *  included). For the deliberate security actions: a password change
     *  or reset, "sign out everywhere", an admin's End sessions, disable or
     *  role change, and a stolen device token presented again. NOT a plain
     *  sign-out. */
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
      // this ends it. Under the login's OAuth lock, the one a refresh and a
      // code exchange take, so a grant minted at the same moment is either
      // seen here or refused there. The keys under the lock a mint takes,
      // for the same reason.
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
  // Once more if it met a busy lock: the caller has often
  // committed its first step already (a new password), and leaving the old
  // sessions alive after it must not happen silently. A second failure is
  // thrown: the request fails loudly (409 busy), never a quiet success.
  // The owner's or an Admin user's sessions end at the spot
  // login-credential on a narrow exit (0327: the narrow login may not move
  // their session epoch).
  let epoch: number | null;
  try {
    epoch = await onLoginHoldSpot(loginId, () => db.transaction((tx) => run(tx)));
  } catch (err) {
    if (!isBusy(err) && pgErrorCode(err) !== '57014') throw err;
    ended.length = 0;
    unbound.length = 0;
    epoch = await onLoginHoldSpot(loginId, () => db.transaction((tx) => run(tx)));
  }
  // The request's logins are found afresh on the next guard read.
  forgetRequestLogins();
  // After the commit, so a rolled-back end leaves no row.
  auditKeysEnded(loginId, opts.actorId ?? loginId, ended);
  auditPeersUnbound(loginId, opts.actorId ?? loginId, unbound, 'sessions-ended');
  opts.unboundPeerIds?.push(...unbound);
  return epoch;
}

/** One key.revoked row for the keys a session end revoked:
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
  // keys and MCP connectors end with its sessions.
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
 *  credential was checked at (Login.sessionEpoch), read with the login's
 *  row by the session guard. It is not read again here: a re-read would
 *  need the system pool, since no scope reads auth.users. `ttlSeconds` shortens it (a member's:
 *  SHORT_ASSET_TOKEN_TTL_SECONDS). */
export function mintAssetToken(
  anchorId: string,
  loginId: string,
  sessionEpoch: number,
  opts: { ttlSeconds?: number } = {},
): string {
  return buildAssetToken(anchorId, loginId, sessionEpoch, opts.ttlSeconds);
}
