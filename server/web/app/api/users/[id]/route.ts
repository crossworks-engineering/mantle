import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq } from '@mantle/db';
import { deleteClientComments } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { deleteLoginSubscriptions, forgetRelayDevices } from '@/lib/push/store';
import {
  applyLoginChange,
  isLastAdminRefusal,
  LAST_ADMIN_MESSAGE,
  loadLoginTarget,
} from '@/lib/login-update';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    /** Never 'member' on the anchor or yourself. Never 'client': a client
     *  login is made as one and stays one (client logins, decision 11). */
    role: z.enum(['admin', 'member']).optional(),
    /** true = the login cannot sign in or use a session it holds. */
    disabled: z.boolean().optional(),
    contactId: z.string().uuid().nullable().optional(),
    /** true = end every session the login holds (cookies, asset tokens,
     *  bearers) without changing anything else: "sign out everywhere". */
    signOut: z.literal(true).optional(),
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

  const target = await loadLoginTarget(targetId);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const done = await applyLoginChange(user, target, body);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.update',
    method: 'PATCH',
    path: `/api/users/${targetId}`,
    detail: {
      targetId,
      targetEmail: target.email,
      changes: body,
      ...(done.sessionsEnded ? { sessionsEnded: true } : {}),
      ...(done.lockingOut
        ? { releasedAgentId: done.releasedAgentId, pushDevicesRemoved: done.pushDevicesRemoved }
        : {}),
    },
    ...requestMetaFrom(req),
  });

  // How many linked brains (peers acting as the login) were unbound, so the
  // admin sees it; binding one to the same login again restores it.
  return NextResponse.json({
    ok: true,
    ...(done.sessionsEnded ? { peersUnbound: done.peersUnbound } : {}),
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const targetId = idParsed.data.id;

  const [target] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      isOwner: authUsers.isOwner,
      role: authUsers.role,
    })
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

  // mobile_tokens, pairing codes, the login's OAuth grants (actor_id, 0164)
  // and its push devices (login_id, 0173) cascade (FKs); the stateless
  // session cookie dies on its next request, since getSessionUser re-checks
  // auth.users per request. The push devices are deleted first, by hand, so
  // the relay can be told: a cascade would drop them silently.
  //
  // A client login (audit I5): its chat thread cascades with it, and its
  // comments go in the same transaction (the admin's bulk comment delete),
  // since a comment whose login is gone could no longer be found by it.
  // Disable is how an admin ends a client and keeps that history.
  const isClient = target.role === 'client';
  let ended: { pushTokens: string[]; commentsDeleted: number };
  try {
    ended = await db.transaction(async (tx) => {
      const tokens = await deleteLoginSubscriptions(targetId, tx);
      const comments = isClient ? await deleteClientComments(user.id, targetId, tx) : 0;
      await tx.delete(authUsers).where(eq(authUsers.id, targetId));
      return { pushTokens: tokens, commentsDeleted: comments };
    });
  } catch (err) {
    if (isLastAdminRefusal(err)) {
      return NextResponse.json({ error: LAST_ADMIN_MESSAGE }, { status: 409 });
    }
    throw err;
  }
  const { pushTokens, commentsDeleted } = ended;
  await forgetRelayDevices(pushTokens);

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'user.delete',
    method: 'DELETE',
    path: `/api/users/${targetId}`,
    detail: { targetId, targetEmail: target.email, ...(isClient ? { commentsDeleted } : {}) },
    ...requestMetaFrom(req),
  });

  return NextResponse.json(isClient ? { ok: true, commentsDeleted } : { ok: true });
}
