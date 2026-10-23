import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, authUsers, eq, onFullSystemRoute } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { deleteLoginSubscriptions, forgetRelayDevices } from '@/lib/push/store';
import {
  adminMembershipChange,
  adminMembershipRefusal,
  applyLoginChange,
  isLastAdminRefusal,
  LAST_ADMIN_MESSAGE,
  loadLoginTarget,
  LoginRoleSchema,
  type LoginChangeDone,
  type LoginChangeRefusal,
} from '@/lib/login-update';
import { readJson } from '@/lib/read-body';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    /** Never 'member' on the anchor or yourself (there is no client role
     *  since workspaces W8a). */
    role: LoginRoleSchema.optional(),
    /** true = the login cannot sign in or use a session it holds. */
    disabled: z.boolean().optional(),
    contactId: z.string().uuid().nullable().optional(),
    /** true = end every session the login holds (cookies, asset tokens,
     *  bearers) without changing anything else: "sign out everywhere". */
    signOut: z.literal(true).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update.');

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });
  const parsed = PatchBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }
  const targetId = idParsed.data.id;
  const body = parsed.data;

  const target = await loadLoginTarget(targetId);
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  // A role change is an add to or a removal from the Admin workspace, by
  // its membership definer in this caller's name (the exit's acting login,
  // which the gateway sends; the definer checks the caller and writes the
  // role column), in the change's one transaction at the full-route spot
  // login-credential (applyLoginChange).
  // target.role is the role membership gives (loadLoginTarget), so the
  // change is decided from membership, and a drifted column is put right.
  const role = body.role;
  const roleChange = role !== undefined && role !== target.role;
  let done: LoginChangeDone | LoginChangeRefusal;
  try {
    done = roleChange
      ? await applyLoginChange(user, target, body, undefined, (tx) =>
          adminMembershipChange(tx, targetId, role === 'admin'),
        )
      : await applyLoginChange(user, target, body);
  } catch (err) {
    // The definer's refusal: the last Moderator of Admin (409), or a caller
    // it refuses, one without the users area (403).
    const refused = adminMembershipRefusal(err);
    if (refused) {
      return NextResponse.json(
        { error: refused.error, reason: refused.reason },
        { status: refused.status },
      );
    }
    throw err;
  }
  // The refusal's reason rides along (W8d): `contact-was-client` and
  // `former-client` among them, as the invite routes name theirs.
  if (!done.ok) {
    return NextResponse.json({ error: done.error, reason: done.reason }, { status: done.status });
  }

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
  const user = ownerCaller();

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
  // the relay can be told: a cascade would drop them silently. A comment
  // keeps its author's name (the FK goes SET NULL): the role grants nothing
  // and takes nothing (W8a).
  // A login's delete cascades its rows (and the brain owner's would
  // cascade the brain): not the narrow login's (access-matrix.ts
  // NARROW_WRITES, auth.users DELETE; 0321 also refuses it the owner's and
  // an Admin user's row). The full-route spot login-credential.
  let ended: { pushTokens: string[] };
  try {
    ended = await onFullSystemRoute('login-credential', () =>
      db.transaction(async (tx) => {
        const tokens = await deleteLoginSubscriptions(targetId, tx);
        await tx.delete(authUsers).where(eq(authUsers.id, targetId));
        return { pushTokens: tokens };
      }),
    );
  } catch (err) {
    if (isLastAdminRefusal(err)) {
      return NextResponse.json({ error: LAST_ADMIN_MESSAGE }, { status: 409 });
    }
    throw err;
  }
  const { pushTokens } = ended;
  await forgetRelayDevices(pushTokens);

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
