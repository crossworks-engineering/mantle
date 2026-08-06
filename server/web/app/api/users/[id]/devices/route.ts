import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, mobileTokens, authUsers, and, eq, isNull, gt, desc } from '@mantle/db';
import { getOwnerOr401, mobileTokenJti } from '@/lib/auth';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/users/[id]/devices — one login's active bearer devices (web clients
 * + mobile companions), for the Settings → Logins "Devices" card. Revoked and
 * expired rows are omitted; `current` marks the device making this request
 * (when it authenticates by bearer).
 *
 * Keyed on the LOGIN (`authUsers.id`), never the anchor `user.id` — a token is
 * minted under the id that signed in (`lib/token-login.ts`), so a co-admin's
 * devices live under their own row. The predecessor at /api/auth/devices read
 * `user.id` and therefore showed every login the anchor's list.
 *
 * No permission tiers, matching the sibling password reset: any login may see
 * and revoke any login's devices, and the audit event is the accountability
 * mechanism. That is what makes "delete the login and sign its devices out"
 * a single screen's work.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const targetId = idParsed.data.id;

  const [target] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

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
        eq(mobileTokens.userId, targetId),
        isNull(mobileTokens.revokedAt),
        gt(mobileTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(mobileTokens.lastUsedAt), desc(mobileTokens.createdAt));

  return NextResponse.json({
    devices: rows.map((r) => ({ ...r, current: r.id === callerJti })),
  });
}
