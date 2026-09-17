import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db, authUsers, mobileTokens, pairingCodes, and, eq, gt, isNull, lt } from '@mantle/db';
import { buildMobileToken } from '@/lib/auth';

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
 * it. Every failure to claim is the same `null` — the phone shows one line.
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
  await db
    .delete(pairingCodes)
    .where(and(eq(pairingCodes.userId, userId), lt(pairingCodes.expiresAt, staleBefore)));
  const [row] = await db
    .insert(pairingCodes)
    .values({ codeHash: hashPairCode(code), userId, expiresAt })
    .returning({ id: pairingCodes.id });
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
 *  or already-claimed code — the caller must not say which. */
export async function claimPairCode(
  code: string,
  deviceName: string | undefined,
  now = new Date(),
): Promise<ClaimedPairCode | null> {
  const codeHash = hashPairCode(code);
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

  const [user] = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, won.userId))
    .limit(1);
  if (!user) return null;

  const label = deviceName?.trim() || 'Mobile device (paired by QR)';
  const jti = randomUUID();
  const minted = buildMobileToken(won.userId, jti);
  await db.insert(mobileTokens).values({
    id: jti,
    userId: won.userId,
    label,
    expiresAt: minted.expiresAt,
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
