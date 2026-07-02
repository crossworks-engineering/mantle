import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, authUsers, eq } from '@mantle/db';
import { getOwnerOr401, updatePassword } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';

const IdParams = z.object({ id: z.string().uuid() });
const Body = z.object({ newPassword: z.string().min(8).max(1024) });

/**
 * Admin password reset — no old password required (that's what
 * /api/auth/change-password is for). No permission tiers by design: any
 * non-read-only login may reset any account, their own included. The audit
 * event is the accountability mechanism.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  // Throttle per acting login — bcrypt is deliberately slow.
  const limit = rateLimit(`users:password-reset:${user.actor.id}`, {
    max: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many password resets. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters.' },
      { status: 400 },
    );
  }
  const targetId = idParsed.data.id;

  const [target] = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  await updatePassword(targetId, parsed.data.newPassword);

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.password_reset',
    method: 'POST',
    path: `/api/users/${targetId}/password`,
    detail: { targetId, targetEmail: target.email },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({ ok: true });
}
