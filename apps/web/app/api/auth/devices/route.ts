import { NextResponse } from 'next/server';
import { db, mobileTokens, and, eq, isNull, gt, desc } from '@mantle/db';
import { getOwnerOr401, mobileTokenJti } from '@/lib/auth';

/**
 * GET /api/auth/devices — the owner's active bearer devices (web clients +
 * mobile companions), for the Settings → Security "Signed-in devices" panel.
 * Revoked and expired rows are omitted; `current` marks the device making
 * this request (when it authenticates by bearer).
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const callerJti = m ? mobileTokenJti(m[1]!.trim()) : null;

  const rows = await db
    .select({
      id: mobileTokens.id,
      label: mobileTokens.label,
      createdAt: mobileTokens.createdAt,
      lastUsedAt: mobileTokens.lastUsedAt,
      expiresAt: mobileTokens.expiresAt,
    })
    .from(mobileTokens)
    .where(
      and(
        eq(mobileTokens.userId, user.id),
        isNull(mobileTokens.revokedAt),
        gt(mobileTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(mobileTokens.lastUsedAt), desc(mobileTokens.createdAt));

  return NextResponse.json({
    devices: rows.map((r) => ({ ...r, current: r.id === callerJti })),
  });
}
