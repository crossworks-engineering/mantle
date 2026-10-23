import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  db,
  onFullSystemRoute,
  authUsers,
  mobileTokens,
  pairingCodes,
  and,
  eq,
  gt,
  isNull,
  lt,
  sql,
} from '@mantle/db';
import { WEB_TOKEN_TTL_SECONDS, adminLogin, buildMobileToken } from '@/lib/auth';
import { loginIsAdmin } from '@/lib/auth/admin-seat';

/**
 * "Sign in on your phone" — the pairing-code half of QR sign-in.
 *
 * The signed-in web app asks for a code ({@link issuePairCode}) and shows it
 * as a QR of `<brain>/pair#v=1&code=<code>`; the phone scans it and claims it
 * ({@link claimPairCode}) for exactly the per-device bearer `mobile-login`
 * mints, so Settings → Logins lists and revokes the phone like any other.
 *
 * Properties the routes rely on: the code is 192 random bits, stored only as
 * its SHA-256; it lives {@link PAIR_CODE_TTL_SEC}; it is single-use — the
 * claim is one conditional UPDATE (unclaimed AND unexpired) so two claims of
 * the same frame cannot both win; it is bound to the login that asked for
 * it, and claims only while that login is not disabled and is still an
 * admin, or (workspaces W7e) a member claiming from a phone build that
 * serves every login (`nonAdmin`). Every failure to claim is the same
 * `null`: the phone shows one line. A member's code scanned by an older
 * phone app is `'update-app'` (426 "Update the app"), and the code stays
 * unused, so the person can scan it again with the new app.
 */
export const PAIR_CODE_TTL_SEC = 90;

/** The QR payload's version; the phone refuses anything else. */
export const PAIR_PAYLOAD_VERSION = 1;

export function generatePairCode(): string {
  return randomBytes(24).toString('base64url');
}

export function hashPairCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** The URL the QR encodes. The code rides in the fragment so it never reaches
 *  a server log; a browser that scans it lands on `/pair`, which explains and
 *  shows nothing. `origin` is the BRAIN's public origin (the phone reads it
 *  as the server address), not the client app's. */
export function pairPayloadUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/pair#v=${PAIR_PAYLOAD_VERSION}&code=${encodeURIComponent(code)}`;
}

export type IssuedPairCode = { id: string; code: string; expiresAt: Date };

/** Mint a code for `userId` (the login that will be signed in by the claim).
 *  Also sweeps that login's stale rows, so a page left open all day does not
 *  pile them up. */
export async function issuePairCode(userId: string, now = new Date()): Promise<IssuedPairCode> {
  const code = generatePairCode();
  const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_SEC * 1000);
  const staleBefore = new Date(now.getTime() - 60 * 60 * 1000);
  // A code signs a phone in as the login: a way in, which the narrow login
  // may not mint (it holds no INSERT on pairing_codes); on the login-self
  // exit it runs at the full-route spot pair-code (docs/runtime-role.md).
  const row = await onFullSystemRoute('pair-code', async () => {
    await db
      .delete(pairingCodes)
      .where(and(eq(pairingCodes.userId, userId), lt(pairingCodes.expiresAt, staleBefore)));
    const [r] = await db
      .insert(pairingCodes)
      .values({ codeHash: hashPairCode(code), userId, expiresAt })
      .returning({ id: pairingCodes.id });
    return r;
  });
  return { id: row!.id, code, expiresAt };
}

export type ClaimedPairCode = {
  token: string;
  expiresIn: number;
  expiresAt: Date;
  deviceId: string;
  userId: string;
  email: string;
  label: string;
};

/** Trade a scanned code for a mobile bearer. `null` for an unknown, expired
 *  or already-claimed code: the caller must not say which. `nonAdmin`: the
 *  phone build serves every login (W7e), so a member's code is claimed (a
 *  30-day token, rotated like device-login's); without it a member's code
 *  answers `'update-app'` and is not used up. */
export async function claimPairCode(
  code: string,
  deviceName: string | undefined,
  now = new Date(),
  opts: { nonAdmin?: boolean } = {},
): Promise<ClaimedPairCode | 'update-app' | null> {
  const codeHash = hashPairCode(code);
  if (!opts.nonAdmin) {
    // Read before the claim, so the code is not spent on an app that cannot
    // use it. Only a live, unclaimed code of a non-Admin login says so.
    const [peek] = await db
      .select({
        // Admin membership (mantle_login_role, S8b), never the column.
        inAdmin: sql<boolean>`"public"."mantle_login_role"(${pairingCodes.userId}) = 'admin'`,
      })
      .from(pairingCodes)
      .innerJoin(authUsers, eq(authUsers.id, pairingCodes.userId))
      .where(
        and(
          eq(pairingCodes.codeHash, codeHash),
          isNull(pairingCodes.claimedAt),
          gt(pairingCodes.expiresAt, now),
        ),
      )
      .limit(1);
    // A member's code only (a login outside Admin: membership decides,
    // S8b; no client login is left since 0272).
    if (peek && !peek.inAdmin) return 'update-app';
  }
  // Single-use, atomically: only an unclaimed, unexpired row flips.
  const [won] = await db
    .update(pairingCodes)
    .set({ claimedAt: now })
    .where(
      and(
        eq(pairingCodes.codeHash, codeHash),
        isNull(pairingCodes.claimedAt),
        gt(pairingCodes.expiresAt, now),
      ),
    )
    .returning({ id: pairingCodes.id, userId: pairingCodes.userId });
  if (!won) return null;

  // The login is re-read, not trusted from the code: lockout drops unclaimed
  // codes, but a claim racing it (or a row that outlived it) must not mint a
  // bearer for a login that is gone, disabled or of a role this phone build
  // cannot serve. An Admin login always (adminLogin: a user of Admin
  // now, read with the row); a member only from a build that
  // serves every login (W7e). A client signs in with its emailed code
  // instead.
  const [user] = await db
    .select({
      email: authUsers.email,
      disabledAt: authUsers.disabledAt,
      adminMember: loginIsAdmin(won.userId),
    })
    .from(authUsers)
    .where(eq(authUsers.id, won.userId))
    .limit(1);
  const admin = !!user && adminLogin({ adminMember: user.adminMember === true });
  // Not an Admin user is a member (membership decides, S8b): for an
  // enabled login the column said the same, and a disabled one is refused.
  const member = !!user && !admin && opts.nonAdmin === true;
  if (!user || user.disabledAt || (!admin && !member)) return null;

  const label = deviceName?.trim() || 'Mobile device (paired by QR)';
  const jti = randomUUID();
  // An admin's bearer as mobile-login mints it (every shipped build depends
  // on it); a member's as device-login does (30 days, refreshed).
  const minted = member
    ? buildMobileToken(won.userId, jti, WEB_TOKEN_TTL_SECONDS)
    : buildMobileToken(won.userId, jti);
  await db.insert(mobileTokens).values({
    id: jti,
    userId: won.userId,
    label,
    expiresAt: minted.expiresAt,
    // The QR claim is where this person proved who they are for the device.
    signedInAt: new Date(),
  });
  await db.update(pairingCodes).set({ claimedDeviceId: jti }).where(eq(pairingCodes.id, won.id));

  return {
    token: minted.value,
    expiresIn: minted.expiresInSec,
    expiresAt: minted.expiresAt,
    deviceId: jti,
    userId: won.userId,
    email: user.email,
    label,
  };
}

export type PairCodeStatus = 'pending' | 'claimed' | 'expired';

/** For the web page's poll: what became of a code THIS login issued. Another
 *  login's code, or an unknown id, reads as expired. */
export async function pairCodeStatus(
  id: string,
  userId: string,
  now = new Date(),
): Promise<{ status: PairCodeStatus; deviceLabel: string | null }> {
  const [row] = await db
    .select({
      claimedDeviceId: pairingCodes.claimedDeviceId,
      claimedAt: pairingCodes.claimedAt,
      expiresAt: pairingCodes.expiresAt,
    })
    .from(pairingCodes)
    .where(and(eq(pairingCodes.id, id), eq(pairingCodes.userId, userId)))
    .limit(1);
  if (!row) return { status: 'expired', deviceLabel: null };
  if (row.claimedAt) {
    let deviceLabel: string | null = null;
    if (row.claimedDeviceId) {
      const [device] = await db
        .select({ label: mobileTokens.label })
        .from(mobileTokens)
        .where(eq(mobileTokens.id, row.claimedDeviceId))
        .limit(1);
      deviceLabel = device?.label ?? null;
    }
    return { status: 'claimed', deviceLabel };
  }
  if (row.expiresAt.getTime() <= now.getTime()) return { status: 'expired', deviceLabel: null };
  return { status: 'pending', deviceLabel: null };
}
