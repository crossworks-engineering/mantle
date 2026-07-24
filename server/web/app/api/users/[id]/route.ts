import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, authUsers, eq } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z.object({
  displayName: z.string().trim().max(120).nullable(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }
  const targetId = idParsed.data.id;

  const [target] = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const displayName = parsed.data.displayName || null;
  await db.update(authUsers).set({ displayName }).where(eq(authUsers.id, targetId));

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.update',
    method: 'PATCH',
    path: `/api/users/${targetId}`,
    detail: { targetId, targetEmail: target.email, changes: { displayName } },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const targetId = idParsed.data.id;

  const [target] = await db
    .select({ id: authUsers.id, email: authUsers.email, isOwner: authUsers.isOwner })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  // All brain content is keyed to the anchor's id — deleting it would orphan
  // the whole tree. This also satisfies "never delete the last user".
  if (target.isOwner) {
    return NextResponse.json(
      { error: 'The original account cannot be deleted — the brain is keyed to it.' },
      { status: 403 },
    );
  }
  // No self-service exits that dodge attribution: someone else must remove you.
  if (target.id === user.actor.id) {
    return NextResponse.json(
      { error: 'You cannot delete the account you are signed in with.' },
      { status: 403 },
    );
  }

  // mobile_tokens / oauth rows cascade (FKs); the stateless session cookie dies
  // on its next request — getSessionUser re-checks auth.users per request.
  await db.delete(authUsers).where(eq(authUsers.id, targetId));

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.delete',
    method: 'DELETE',
    path: `/api/users/${targetId}`,
    detail: { targetId, targetEmail: target.email },
    ...requestMetaFrom(req),
  });

  return NextResponse.json({ ok: true });
}
