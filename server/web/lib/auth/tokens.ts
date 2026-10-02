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
 * invalidates every outstanding credential at once. One login's cookies and
 * asset tokens end together through their `ep` claim: the login's
 * auth.users.session_epoch when they were minted (0181). The session layer
 * compares it with the row on every request, so bumping the column (password
 * change, disable, role change, sign out everywhere) ends them all. A value
 * without `ep` is epoch 0: what every login starts at.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RENDER_COOKIE_NAME, SESSION_COOKIE_NAME } from '../auth-constants';
import { env } from '@mantle/config';

/** The `k` claim: mobile bearer, asset token, app frame, render cookie,
 *  contact visitor (contact shares). 'c' (the retired team-chat credential)
 *  and 't' (the retired team-visitor cookie) are reserved: no verifier takes
 *  them. */
type TokenKind = 'm' | 'a' | 'f' | 'r' | 'v';

/**
 * Claims whose signature, kind and expiry have already been checked. Every
 * field beyond `exp` is still untrusted in SHAPE — each verifier narrows the
 * claims it cares about before handing them to a caller.
 */
type SignedClaims = Record<string, unknown> & { exp: number };

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function secret(): Buffer {
  const s = env('SESSION_SECRET');
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET must be set (>=32 chars). Run `openssl rand -base64 48`.');
  }
  return Buffer.from(s);
}

/**
 * A key for one purpose, derived from SESSION_SECRET (HMAC with the purpose
 * as the message): local to this brain, never sent anywhere, and never the
 * signing key itself. Rotating SESSION_SECRET rotates it.
 */
export function derivedSecret(purpose: string): Buffer {
  return createHmac('sha256', secret()).update(`mantle-derived:${purpose}`).digest();
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

/** The `ep` claim: absent is epoch 0 (a value minted before 0181); anything
 *  but a non-negative integer makes the value invalid (null). */
function epochClaim(claims: SignedClaims): number | null {
  const ep = claims.ep;
  if (ep === undefined) return 0;
  return typeof ep === 'number' && Number.isInteger(ep) && ep >= 0 ? ep : null;
}

// ── Session cookies (kindless) ───────────────────────────────────────────────

export { RENDER_COOKIE_NAME, SESSION_COOKIE_NAME };

/** Mint a session cookie for the login `userId`. `epoch` is the login's
 *  session_epoch now (a stale one fails on the next request, so a caller
 *  that passes the wrong value signs the user out, never in). */
export function buildSessionCookie(
  userId: string,
  opts: { epoch?: number; ttlSeconds?: number } = {},
): { value: string; maxAgeSec: number } {
  const ttlSeconds = opts.ttlSeconds ?? ONE_YEAR_SECONDS;
  return {
    value: signClaims({ uid: userId, ep: opts.epoch ?? 0 }, ttlSeconds).value,
    maxAgeSec: ttlSeconds,
  };
}

/**
 * Verify a session cookie value: signature, expiry, and that it is KINDLESS.
 * `ep` is the login's session epoch when it was minted; the caller compares
 * it with the row (see resolveLogin).
 *
 * The kind check is the load-bearing part. Mobile (`k:'m'`) and asset (`k:'a'`)
 * tokens share the `{uid, exp}` payload, so without it a signed mobile token
 * pasted into the cookie would authenticate through this DB-lookup path — which
 * never consults mobile_tokens.revoked_at, dodging a mobile logout — and an
 * asset token would grant full session access instead of just byte-serving.
 */
export function verifySessionCookie(
  value: string,
): { uid: string; exp: number; ep: number } | null {
  const claims = verifySigned(value, null);
  if (!claims || typeof claims.uid !== 'string') return null;
  const ep = epochClaim(claims);
  if (ep === null) return null;
  return { uid: claims.uid, exp: claims.exp, ep };
}

// ── Render cookies (`k:'r'`) ────────────────────────────────────────────────
// What the browser sidecar carries when it loads a render surface for an
// export (lib/render-sandbox.ts). It used to be a full kindless session cookie
// for the anchor, sent as an extra header on EVERY request the page made, so an
// external image in a printed page handed the anchor's session to that host
// (audit F01). Now it is its own kind, minted for the ACTING login, set as a
// cookie on the print origin only, and the gate accepts it for the render
// surfaces and the byte routes they load, GET only (isRenderPath in
// lib/auth-constants.ts). The session, asset and bearer verifiers all reject
// kind 'r', so it is never a session. `n` binds the page it opens: a render
// cookie for one drawing cannot print another page.

const RENDER_TOKEN_TTL_SECONDS = 300; // one render; bounds a leaked value.

export type RenderClaims = {
  /** The anchor: whose brain the render reads. */
  uid: string;
  /** The login the render is for: the admin who asked for the export, or the
   *  anchor for a cache fill nobody asked for. Re-checked on every request. */
  act: string;
  /** The node the render surface may open (/print/pages/:n, /print/draws/:n,
   *  /render/draws/:n). Byte routes the page loads are not bound to it. */
  n: string;
};

/** Mint a render cookie VALUE (see block comment). Never sent to a client. */
export function buildRenderToken(opts: {
  ownerId: string;
  actorId: string;
  nodeId: string;
  ttlSeconds?: number;
}): string {
  return signClaims(
    { uid: opts.ownerId, act: opts.actorId, n: opts.nodeId, k: 'r' },
    opts.ttlSeconds ?? RENDER_TOKEN_TTL_SECONDS,
  ).value;
}

/** Verify a render cookie's signature, expiry and kind (`k:'r'`). No DB: the
 *  caller must still confirm `act` is a usable admin of the `uid` brain. */
export function verifyRenderToken(value: string): RenderClaims | null {
  const claims = verifySigned(value, 'r');
  if (
    !claims ||
    typeof claims.uid !== 'string' ||
    typeof claims.act !== 'string' ||
    typeof claims.n !== 'string'
  ) {
    return null;
  }
  return { uid: claims.uid, act: claims.act, n: claims.n };
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
 *  year; the web client passes WEB_TOKEN_TTL_SECONDS. `epoch` binds the token
 *  to the login's session epoch (a CLIENT's device token always carries it:
 *  the session layer refuses the token once the row's epoch moves on, as it
 *  refuses the client's cookie). */
export function buildMobileToken(
  userId: string,
  jti: string,
  ttlSeconds: number = MOBILE_TOKEN_TTL_SECONDS,
  epoch?: number,
): { value: string; expiresInSec: number; expiresAt: Date } {
  const { value, exp } = signClaims(
    { uid: userId, jti, k: 'm', ...(epoch !== undefined ? { ep: epoch } : {}) },
    ttlSeconds,
  );
  return { value, expiresInSec: ttlSeconds, expiresAt: new Date(exp * 1000) };
}

/** `ep` is set only on a token minted with an epoch (a client's). */
export type MobileClaims = { uid: string; jti: string; exp: number; ep?: number };

/** Verify a mobile token's signature, expiry and kind. No DB — the caller must
 *  still confirm the mobile_tokens row is present and unrevoked, and compare
 *  `ep` (when the token carries one) with the login row. */
export function verifyMobileToken(token: string): MobileClaims | null {
  const claims = verifySigned(token, 'm');
  if (!claims || typeof claims.uid !== 'string' || typeof claims.jti !== 'string') return null;
  if (claims.ep === undefined) return { uid: claims.uid, jti: claims.jti, exp: claims.exp };
  const ep = epochClaim(claims);
  if (ep === null) return null;
  return { uid: claims.uid, jti: claims.jti, exp: claims.exp, ep };
}

/** Extract the `jti` from a (valid) mobile token — used by logout to revoke. */
export function mobileTokenJti(token: string): string | null {
  return verifyMobileToken(token)?.jti ?? null;
}

// ── Asset access tokens (`k:'a'`) ────────────────────────────────────────────
// Short-lived, owner-scoped, stateless token for browser-native asset sources —
// `<img>`/`<iframe>`/download `src`s to `/api/files/files/[id]?raw=1`,
// `/api/attachments/[id]` and `/api/export/[id]` — which CANNOT carry an
// Authorization header, so a
// detached/Electron client (cross-origin, no cookie) can't otherwise load them.
// Delivered in the URL (`?at=`), so the TTL is deliberately short to bound a
// leaked URL; no revocation row (unlike mobile tokens): the TTL, the login's
// session epoch (`ep`, compared with the row on use) and secret rotation are
// the kill switches. Scope is byte-serving only: the gate accepts it for asset
// paths exclusively, and the session verifier rejects any kinded token.

const ASSET_TOKEN_TTL_SECONDS = 2 * 60 * 60; // 2h — one working session.
/** A CLIENT login's asset token (client logins audit B23): 10 minutes. The
 *  client shell re-mints it every 60 s, so a live portal never sees it
 *  expire, while a download URL left in a shared browser's history dies
 *  soon after the client leaves. */
export const CLIENT_ASSET_TOKEN_TTL_SECONDS = 10 * 60;

/** Mint a short-lived asset-access token for `userId` (see block comment).
 *  `actorId` names the LOGIN the token was minted for, when it differs from
 *  the anchor: per-login asset routes (the profile photo) read it so a
 *  detached second admin sees their own face, while owner-scoped byte routes
 *  keep using `uid` (everything is owned by the anchor). `epoch` is the
 *  session_epoch of that login (`actorId`, else `userId`): a bump ends the
 *  token within its 2 hours, like the login's cookies. `ttlSeconds` shortens
 *  it (a client's: CLIENT_ASSET_TOKEN_TTL_SECONDS). */
export function buildAssetToken(
  userId: string,
  actorId?: string,
  epoch = 0,
  ttlSeconds = ASSET_TOKEN_TTL_SECONDS,
): string {
  return signClaims(
    {
      uid: userId,
      ...(actorId && actorId !== userId ? { act: actorId } : {}),
      ep: epoch,
      k: 'a',
    },
    Math.min(ttlSeconds, ASSET_TOKEN_TTL_SECONDS),
  ).value;
}

/** Verify an asset token's signature, expiry and kind (`k:'a'`). No DB: the
 *  caller compares `ep` with the login row. */
export function verifyAssetToken(token: string): { uid: string; act?: string; ep: number } | null {
  const claims = verifySigned(token, 'a');
  if (!claims || typeof claims.uid !== 'string') return null;
  const ep = epochClaim(claims);
  if (ep === null) return null;
  return {
    uid: claims.uid,
    ...(typeof claims.act === 'string' ? { act: claims.act } : {}),
    ep,
  };
}

// ── Team-visitor cookies (`k:'t'`): retired ──────────────────────────────────
// The share-scoped visitor cookie (`mantle_team`) a team-code holder got at a
// team link's token prompt went with team links in member logins Phase 6
// stage 6. Nothing mints or accepts kind 't' any more; the kind stays
// reserved so an old value can never be read as something else.

// ── Team-chat cookies (`k:'c'`): retired ─────────────────────────────────────
// The brain-level team-chat credential (the `mantle_team_chat` cookie, and the
// same value as a bearer) went with /team, /hub and /api/team/* in member
// logins Phase 6. Nothing mints or accepts kind 'c' any more; the kind stays
// reserved so an old value can never be read as something else.

// ── Contact visitor values (`k:'v'`) ─────────────────────────────────────────
// Set after a contact types their code at a contact share's prompt (contact
// shares, migration 0214; POST /s/<token>/code). The value names the CONTACT
// (`cid`), the brain (`oid`, its owner id) and the contact's code epoch
// (`ce`) when it was minted. It opens nothing by itself: the gate
// (lib/contact-share-gate.ts) admits it only on a live share for THAT
// contact, while the contact's sharing is on, not locked, and still at that
// epoch. Regenerate and switch off move the epoch, so every value of the
// contact dies on its next request. The cookie (`mantle_contact`, path
// /s/) may carry values for several contacts, joined by '~'; the gate tries
// each. Every other verifier rejects kind 'v'.

export const CONTACT_VISITOR_COOKIE = 'mantle_contact';
export const CONTACT_VISITOR_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ContactVisitorClaims = {
  contactId: string;
  ownerId: string;
  codeEpoch: number;
  /** Seconds since the epoch at mint time. */
  issuedAt: number;
};

/** Mint a contact visitor value. */
export function buildContactVisitorValue(opts: {
  contactId: string;
  ownerId: string;
  codeEpoch: number;
}): { value: string; maxAgeSec: number } {
  const { value } = signClaims(
    {
      cid: opts.contactId,
      oid: opts.ownerId,
      ce: opts.codeEpoch,
      iat: Math.floor(Date.now() / 1000),
      k: 'v',
    },
    CONTACT_VISITOR_TTL_SECONDS,
  );
  return { value, maxAgeSec: CONTACT_VISITOR_TTL_SECONDS };
}

/** Verify a contact visitor value: signature, expiry, kind. No DB: the gate
 *  still checks the share, the contact's sharing and the epoch. */
export function verifyContactVisitorValue(value: string): ContactVisitorClaims | null {
  const claims = verifySigned(value, 'v');
  if (
    !claims ||
    typeof claims.cid !== 'string' ||
    typeof claims.oid !== 'string' ||
    typeof claims.ce !== 'number' ||
    !Number.isSafeInteger(claims.ce) ||
    claims.ce < 1
  ) {
    return null;
  }
  return {
    contactId: claims.cid,
    ownerId: claims.oid,
    codeEpoch: claims.ce,
    issuedAt: typeof claims.iat === 'number' ? claims.iat : 0,
  };
}

// ── App-frame tickets (`k:'f'`) ──────────────────────────────────────────────
// The mini-app sandbox iframe navigates to a real URL (/api/apps/[id]/frame or
// /s/[token]/frame) instead of an inlined srcdoc. That navigation can carry NO
// credential: the iframe is sandboxed without allow-same-origin (opaque origin
// ⇒ no cookies), and an iframe src can't attach a bearer header. So the parent
// — which CAN authenticate (session cookie, an active share token, or the
// split client's bearer) — mints this ticket first and puts it in the frame URL
// (`?t=`). Delivered in a URL, so the TTL is seconds, not hours: it outlives
// one navigation and nothing else. Claims bind the ticket to ONE app (and, on
// the share surface, ONE share), so a leaked ticket can serve exactly one
// app's already-built bundle for a few seconds and can never escalate — the
// session/mobile/asset verifiers all reject kind 'f'.

const APP_FRAME_TICKET_TTL_SECONDS = 120;

/** Mint an app-frame ticket. `shareId` set ⇒ share surface (published build
 *  only); `loginId` set ⇒ member surface (a member login, published build
 *  only, /api/member/apps/:id/frame); `loginId` AND `clientEpoch` set ⇒
 *  client surface (a client login, published build only,
 *  /api/client/apps/:id/frame, client logins C6); none ⇒ owner surface
 *  (`uid` = the owner, draft build allowed). `loginId` lets the member and
 *  client frame routes re-check the login's liveness: a removed member loses
 *  access at once, not at ticket expiry. `clientEpoch` is the client login's
 *  session epoch at mint time: Sign out, End sessions and Disable bump it,
 *  and the client frame refuses a ticket of an older epoch. A client ticket
 *  still carries `mem`, so every frame that refuses a login ticket (owner,
 *  share) refuses a client's too. `actorId` (owner surface only) names the
 *  admin login that opened the frame, so the frame can answer host.me()
 *  (app identity); the owner frame route is the only one that reads it. */
export function buildAppFrameTicket(opts: {
  ownerId: string;
  appId: string;
  actorId?: string;
  shareId?: string;
  loginId?: string;
  clientEpoch?: number;
  /** A contact share's contact and code epoch (contact shares): the share
   *  frame re-checks both, since the frame navigation carries no cookie. */
  contact?: { contactId: string; codeEpoch: number };
}): string {
  const claims: Record<string, unknown> = { uid: opts.ownerId, app: opts.appId, k: 'f' };
  if (opts.shareId) claims.sh = opts.shareId;
  if (opts.shareId && opts.contact) {
    claims.cid = opts.contact.contactId;
    claims.ce = opts.contact.codeEpoch;
  }
  if (opts.loginId) claims.mem = opts.loginId;
  if (opts.loginId && opts.clientEpoch !== undefined) claims.cep = opts.clientEpoch;
  // Only an owner ticket names an admin actor: a share, member or client
  // ticket already says who runs the app.
  if (opts.actorId && !opts.shareId && !opts.loginId) claims.act = opts.actorId;
  return signClaims(claims, APP_FRAME_TICKET_TTL_SECONDS).value;
}

/** Verify an app-frame ticket: signature, expiry, kind (`k:'f'`). No DB —
 *  callers must still confirm the app (and share, when `shareId` is set)
 *  matches the route being served, and re-check a member login's liveness
 *  via `loginId`. A `cid` claim counts only on a share ticket, with its `ce`
 *  (a contact share's contact and code epoch); the share frame re-checks
 *  both. A `cid` alone (a retired team visitor's) is ignored. */
export type AppFrameTicket = {
  ownerId: string;
  appId: string;
  shareId?: string;
  /** A member login's ticket: only the member frame route may accept it.
   *  Also set on a client's ticket (with `clientEpoch`). */
  loginId?: string;
  /** A CLIENT login's ticket (client logins C6): the login's session epoch
   *  at mint time. Only the client frame route accepts it; the member frame
   *  refuses a ticket that carries it. */
  clientEpoch?: number;
  /** A contact share's ticket: the contact and its code epoch at mint time
   *  (only with `shareId`). */
  contactId?: string;
  codeEpoch?: number;
  /** An owner ticket's admin login (app identity: host.me()). */
  actorId?: string;
};

export function verifyAppFrameTicket(value: string): AppFrameTicket | null {
  const claims = verifySigned(value, 'f');
  if (!claims || typeof claims.uid !== 'string' || typeof claims.app !== 'string') return null;
  const out: AppFrameTicket = { ownerId: claims.uid, appId: claims.app };
  if (typeof claims.sh === 'string') out.shareId = claims.sh;
  if (typeof claims.mem === 'string') out.loginId = claims.mem;
  if (typeof claims.act === 'string' && !out.shareId && !out.loginId) out.actorId = claims.act;
  // A contact share's ticket carries both `cid` and `ce`. A `cid` alone (a
  // team visitor's, retired with team links) is ignored, as before.
  if (
    out.shareId &&
    typeof claims.cid === 'string' &&
    typeof claims.ce === 'number' &&
    Number.isSafeInteger(claims.ce)
  ) {
    out.contactId = claims.cid;
    out.codeEpoch = claims.ce;
  }
  if (
    typeof claims.cep === 'number' &&
    Number.isSafeInteger(claims.cep) &&
    claims.cep >= 0 &&
    out.loginId
  ) {
    out.clientEpoch = claims.cep;
  } else if (claims.cep !== undefined) {
    return null;
  }
  return out;
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
