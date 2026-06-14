import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db, authUsers, mobileTokens } from '@mantle/db';
import { SESSION_COOKIE_NAME } from './auth-constants';

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

export type SessionUser = { id: string; email: string };

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
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, claims.uid))
    .limit(1);
  if (!row || !row.email) return null;

  await db
    .update(mobileTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mobileTokens.id, claims.jti));

  return { id: row.id, email: row.email };
}

export { SESSION_COOKIE_NAME };

/** Returns the current user, or null. Safe in Server Components.
 *  Resolves a session cookie first; falls back to a mobile bearer token so
 *  every handler that already calls this also accepts the mobile companion. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const c = (await cookies()).get(SESSION_COOKIE_NAME);
  if (c) {
    const data = verify(c.value);
    if (data) {
      const [row] = await db
        .select({ id: authUsers.id, email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, data.uid))
        .limit(1);
      if (row && row.email) return { id: row.id, email: row.email };
    }
  }
  // Mobile companion: Authorization: Bearer <mobile-token>.
  return getBearerUser();
}

/** Gate for protected pages. Redirects to /login if no session. */
export async function requireOwner(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return user;
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
