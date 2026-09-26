import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, and, authUsers, eq, isNull, mobileTokens, nodes } from '@mantle/db';
import { getOwnerOr401, membersEnabled } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    /** 'member' only while MANTLE_MEMBERS=1. Never on the anchor or yourself. */
    role: z.enum(['admin', 'member']).optional(),
    /** true = the login cannot sign in or use a session it holds. */
    disabled: z.boolean().optional(),
    contactId: z.string().uuid().nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update.');

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
  const body = parsed.data;

  const [target] = await db
    .select({ id: authUsers.id, email: authUsers.email, isOwner: authUsers.isOwner })
    .from(authUsers)
    .where(eq(authUsers.id, targetId))
    .limit(1);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const lockingOut = body.role === 'member' || body.disabled === true;
  if (lockingOut && target.isOwner) {
    return NextResponse.json(
      { error: 'The original account is always an admin and cannot be disabled.' },
      { status: 403 },
    );
  }
  if (lockingOut && target.id === user.actor.id) {
    return NextResponse.json(
      { error: 'You cannot demote or disable the account you are signed in with.' },
      { status: 403 },
    );
  }
  if (body.role === 'member' && !membersEnabled()) {
    return NextResponse.json(
      { error: 'Member logins are off on this brain: set MANTLE_MEMBERS=1 first.' },
      { status: 400 },
    );
  }
  if (body.contactId) {
    const [contact] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(eq(nodes.id, body.contactId), eq(nodes.ownerId, user.id), eq(nodes.type, 'contact')),
      )
      .limit(1);
    if (!contact) return NextResponse.json({ error: 'Contact not found.' }, { status: 400 });
  }

  const changes: Partial<typeof authUsers.$inferInsert> = {};
  if (body.displayName !== undefined) changes.displayName = body.displayName || null;
  if (body.role !== undefined) changes.role = body.role;
  if (body.contactId !== undefined) changes.contactId = body.contactId;
  if (body.disabled !== undefined) changes.disabledAt = body.disabled ? new Date() : null;

  await db.transaction(async (tx) => {
    await tx.update(authUsers).set(changes).where(eq(authUsers.id, targetId));
    // Cookies re-read the row every request, so they stop at once. Bearers
    // would too, but revoke them so the device list tells the truth.
    if (lockingOut) {
      await tx
        .update(mobileTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(mobileTokens.userId, targetId), isNull(mobileTokens.revokedAt)));
    }
  });

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.update',
    method: 'PATCH',
    path: `/api/users/${targetId}`,
    detail: { targetId, targetEmail: target.email, changes: body },
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
