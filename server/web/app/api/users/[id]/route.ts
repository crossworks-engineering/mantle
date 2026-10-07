import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  isUniqueViolation,
  db,
  and,
  authUsers,
  eq,
  isNull,
  mobileTokens,
  ne,
  nodes,
  oauthAccessTokens,
  oauthAuthCodes,
  pairingCodes,
} from '@mantle/db';
import {
  deleteClientComments,
  revokeOpenClientSignins,
  settleSpaceOnPromotion,
} from '@mantle/content';
import { endLoginSessions, getOwnerOr401 } from '@/lib/auth';
import { releaseAssignedAgent } from '@/lib/agents';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { deleteLoginSubscriptions, forgetRelayDevices } from '@/lib/push/store';

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

  // Any role but admin locks the login out of admin sessions (client logins
  // C0: named, not "is it member", so a new role can never skip this).
  const lockingOut = (body.role !== undefined && body.role !== 'admin') || body.disabled === true;
  // A role change touches admins and members only: to or from any other role
  // (a client) is refused; disable the login and make a new one (decision 11).
  if (
    body.role !== undefined &&
    body.role !== target.role &&
    target.role !== 'admin' &&
    target.role !== 'member'
  ) {
    return NextResponse.json(
      { error: 'This login cannot change role. Disable it and create a new login.' },
      { status: 400 },
    );
  }
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
  // Users are the team: a member login needs no contact (0167). The link is
  // optional, but it must be a contact of this brain, and one contact names
  // one login: a second login on it would make "who is this" ambiguous.
  if (body.contactId) {
    const [contact] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(eq(nodes.id, body.contactId), eq(nodes.ownerId, user.id), eq(nodes.type, 'contact')),
      )
      .limit(1);
    if (!contact) return NextResponse.json({ error: 'Contact not found.' }, { status: 400 });
    const [taken] = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(and(eq(authUsers.contactId, body.contactId), ne(authUsers.id, targetId)))
      .limit(1);
    if (taken) {
      return NextResponse.json(
        { error: 'That contact is already linked to another user.' },
        { status: 409 },
      );
    }
  }

  const changes: Partial<typeof authUsers.$inferInsert> = {};
  if (body.displayName !== undefined) changes.displayName = body.displayName || null;
  if (body.role !== undefined) changes.role = body.role;
  if (body.contactId !== undefined) changes.contactId = body.contactId;
  if (body.disabled !== undefined) changes.disabledAt = body.disabled ? new Date() : null;

  // Every session the login holds ends (F06) when it is disabled or enabled,
  // when its role changes, or when asked: the session epoch is bumped and
  // its bearers revoked. Re-enabling bumps too, so a cookie from before a
  // disable made by an older release cannot come back to life.
  const endSessions =
    body.signOut === true ||
    body.disabled !== undefined ||
    (body.role !== undefined && body.role !== target.role);

  const pushTokens: string[] = [];
  let releasedAgentId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      if (Object.keys(changes).length > 0) {
        await tx.update(authUsers).set(changes).where(eq(authUsers.id, targetId));
      }
      if (endSessions) {
        // The login's push devices go with its sessions; the relay is told
        // after the commit (pushTokens).
        await endLoginSessions(targetId, {
          tx,
          removedRoutingTokens: pushTokens,
          endKeys: true,
          actorId: user.actor.id,
        });
        // A client's open sign-in links and emailed codes die with its
        // sessions (audit B14): a link issued before a disable must not
        // work after the enable, and "End sessions" must leave no way back
        // in. Other roles hold none, so this is a no-op for them.
        await revokeOpenClientSignins(tx, targetId);
      }
      // A member made admin: what they shared or submitted as a member goes
      // back to private drafts (audit F21). An admin's items are never team
      // drafts or reviewed, and a later demotion must not bring them back.
      if (body.role === 'admin') await settleSpaceOnPromotion(tx, targetId);
      // Cookies re-read the row every request, so they stop at once. Bearers
      // and connector (OAuth) grants would too (both re-check the login), but
      // revoke them so the device and connector lists tell the truth. Unclaimed
      // pairing codes die too, so a QR shown before the lockout cannot pair.
      // The login's push devices go (0173): nothing else would stop the brain
      // pushing to its phone. Its personal assistant is released (kept, never
      // deleted): a member chats only with team-level agents.
      if (lockingOut) {
        pushTokens.push(...(await deleteLoginSubscriptions(targetId, tx)));
        releasedAgentId = (await releaseAssignedAgent(user.id, targetId, tx))?.id ?? null;
        const now = new Date();
        await tx
          .update(mobileTokens)
          .set({ revokedAt: now })
          .where(and(eq(mobileTokens.userId, targetId), isNull(mobileTokens.revokedAt)));
        await tx
          .update(oauthAccessTokens)
          .set({ revokedAt: now })
          .where(and(eq(oauthAccessTokens.actorId, targetId), isNull(oauthAccessTokens.revokedAt)));
        await tx.delete(oauthAuthCodes).where(eq(oauthAuthCodes.actorId, targetId));
        await tx
          .delete(pairingCodes)
          .where(and(eq(pairingCodes.userId, targetId), isNull(pairingCodes.claimedAt)));
      }
    });
  } catch (err) {
    // Two links to one contact at once: the check above passed for both, the
    // unique index (0181) stops the second.
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: 'That contact is already linked to another user.' },
        { status: 409 },
      );
    }
    throw err;
  }
  // After the commit, as the single unpair route does: tell the relay.
  await forgetRelayDevices(pushTokens);

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
      ...(endSessions ? { sessionsEnded: true } : {}),
      ...(lockingOut ? { releasedAgentId, pushDevicesRemoved: pushTokens.length } : {}),
    },
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
  const { pushTokens, commentsDeleted } = await db.transaction(async (tx) => {
    const tokens = await deleteLoginSubscriptions(targetId, tx);
    const comments = isClient ? await deleteClientComments(user.id, targetId, tx) : 0;
    await tx.delete(authUsers).where(eq(authUsers.id, targetId));
    return { pushTokens: tokens, commentsDeleted: comments };
  });
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
