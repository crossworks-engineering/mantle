import { z } from 'zod';
import { LOGIN_ROLES, isLoginRole, type LoginRole } from '@mantle/client-types/role-names';
import {
  isCheckViolation,
  isUniqueViolation,
  db,
  and,
  authUsers,
  onFullSystemRoute,
  onLoginHoldSpot,
  eq,
  isNull,
  mobileTokens,
  ne,
  nodes,
  oauthAccessTokens,
  oauthAuthCodes,
  pairingCodes,
  sql,
} from '@mantle/db';
import {
  FORMER_CLIENT_CONTACT_MESSAGE,
  FORMER_CLIENT_ENABLE_MESSAGE,
  isFormerClientContact,
  isFormerClientLogin,
  settleSpaceOnPromotion,
} from '@mantle/content';
import {
  auditKeysEnded,
  endLoginSessions,
  forgetRequestLogins,
  type SessionUser,
} from '@/lib/auth';
import { auditPeersUnbound } from '@/lib/peer-unbind';
import { releaseAssignedAgent } from '@/lib/agents';
import { deleteLoginSubscriptions, forgetRelayDevices } from '@/lib/push/store';

/**
 * One change to a login row (PATCH /api/users/:id), and the role change the
 * Admin workspace's user list makes (workspaces W5a: a user of the Admin
 * workspace IS an admin login until W5b, and the 0251 login bridge keeps the
 * Admin and Team rows in step with the role). Both paths end the same
 * sessions, settle the same drafts and lock the same devices out.
 */

/** A login role in a request body: the users routes' zod enum over
 *  LOGIN_ROLES (A10 #13), so a role added there is accepted here too. */
export const LoginRoleSchema = z.enum(LOGIN_ROLES);

export type LoginChange = {
  displayName?: string | null;
  /** Never 'member' on the anchor or yourself. */
  role?: LoginRole;
  disabled?: boolean;
  contactId?: string | null;
  signOut?: true;
};

export type LoginTarget = { id: string; email: string; isOwner: boolean; role: string };

/** Why a change is refused, said plainly, with its HTTP status. */
export type LoginChangeRefusal = {
  ok: false;
  status: 400 | 403 | 409;
  error: string;
  reason:
    | 'role-fixed'
    | 'owner'
    | 'self'
    | 'contact-missing'
    | 'contact-taken'
    | 'last-admin'
    | 'former-client'
    | 'contact-was-client';
};

export type LoginChangeDone = {
  ok: true;
  sessionsEnded: boolean;
  lockingOut: boolean;
  peersUnbound: number;
  releasedAgentId: string | null;
  pushDevicesRemoved: number;
};

/** The login row a change is about, or null. */
export async function loadLoginTarget(id: string): Promise<LoginTarget | null> {
  const [row] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      isOwner: authUsers.isOwner,
      role: authUsers.role,
    })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  return row ?? null;
}

type LoginTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Apply `change` to `target` for `actor`. `inTx` runs last inside the same
 * transaction (the workspace screen writes its own rows there), after the
 * login bridge has written the Admin and Team rows the new role gives.
 * `firstInTx` runs first in it, before any write: the workspace screen
 * locks the workspace and checks its rules there (W5a audit L2), against
 * the rows as they are before the bridge changes them. What it throws ends
 * the transaction and is thrown on.
 */
export async function applyLoginChange(
  actor: SessionUser,
  target: LoginTarget,
  change: LoginChange,
  inTx?: (tx: LoginTx) => Promise<void>,
  firstInTx?: (tx: LoginTx) => Promise<void>,
): Promise<LoginChangeDone | LoginChangeRefusal> {
  const targetId = target.id;
  // Any role but admin locks the login out of admin sessions (named, not
  // "is it member", so a new role can never skip this).
  const lockingOut =
    (change.role !== undefined && change.role !== 'admin') || change.disabled === true;
  // A role change touches admins and members only: a row with a role this
  // code does not know is refused (fail closed); disable it instead.
  if (change.role !== undefined && change.role !== target.role && !isLoginRole(target.role)) {
    return {
      ok: false,
      status: 400,
      reason: 'role-fixed',
      error: 'This login cannot change role. Disable it and create a new login.',
    };
  }
  // A former client login (archived by 0272) stays disabled: enabling it
  // would bring a client back as a member by itself (W8a fix round 1).
  if (change.disabled === false && (await isFormerClientLogin(target.id))) {
    return {
      ok: false,
      status: 409,
      reason: 'former-client',
      error: FORMER_CLIENT_ENABLE_MESSAGE,
    };
  }
  if (lockingOut && target.isOwner) {
    return {
      ok: false,
      status: 403,
      reason: 'owner',
      error: 'The original account is always an admin and cannot be disabled.',
    };
  }
  if (lockingOut && target.id === actor.actor.id) {
    return {
      ok: false,
      status: 403,
      reason: 'self',
      error: 'You cannot demote or disable the account you are signed in with.',
    };
  }
  // Users are the team: a member login needs no contact (0167). The link is
  // optional, but it must be a contact of this brain, and one contact names
  // one login: a second login on it would make "who is this" ambiguous.
  if (change.contactId) {
    const [contact] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(eq(nodes.id, change.contactId), eq(nodes.ownerId, actor.id), eq(nodes.type, 'contact')),
      )
      .limit(1);
    if (!contact) {
      return { ok: false, status: 400, reason: 'contact-missing', error: 'Contact not found.' };
    }
    // The contact of a former client (archived by 0272) is not linked to
    // another login: that would bring the client back as a member by itself,
    // as an invite or a new login on it would (W8a leftover, closed in W8d).
    if (await isFormerClientContact(change.contactId, db, targetId)) {
      return {
        ok: false,
        status: 409,
        reason: 'contact-was-client',
        error: FORMER_CLIENT_CONTACT_MESSAGE,
      };
    }
    const [taken] = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(and(eq(authUsers.contactId, change.contactId), ne(authUsers.id, targetId)))
      .limit(1);
    if (taken) {
      return {
        ok: false,
        status: 409,
        reason: 'contact-taken',
        error: 'That contact is already linked to another user.',
      };
    }
  }

  const changes: Partial<typeof authUsers.$inferInsert> = {};
  if (change.displayName !== undefined) changes.displayName = change.displayName || null;
  if (change.role !== undefined) changes.role = change.role;
  if (change.contactId !== undefined) changes.contactId = change.contactId;
  if (change.disabled !== undefined) changes.disabledAt = change.disabled ? new Date() : null;

  // Every session the login holds ends (F06) when it is disabled or enabled,
  // when its role changes, or when asked: the session epoch is bumped and
  // its bearers revoked. Re-enabling bumps too, so a cookie from before a
  // disable made by an older release cannot come back to life.
  const endSessions =
    change.signOut === true ||
    change.disabled !== undefined ||
    (change.role !== undefined && change.role !== target.role);

  const pushTokens: string[] = [];
  const endedKeyIds: string[] = [];
  const unboundPeerIds: string[] = [];
  let releasedAgentId: string | null = null;
  try {
    // A promotion settles the login's personal space (space_items, a content
    // table) in this transaction: on the narrow exit through its definer
    // (settleSpaceOnPromotion, migration 0316).
    const promotes = change.role === 'admin';
    // A role change or a contact link writes a rights column the narrow
    // login may not (auth.users role and contact_id, and the Admin rows
    // mantle_bridge_login keeps in step; a contact's shares reach the
    // login linked to it): the whole transaction then runs at the full-route spot
    // login-credential (docs/runtime-role.md); any other change stays on
    // the exit's own route. An enable (disabled_at back to NULL) lets the
    // login in again: the narrow login may only set disabled_at (0318), so
    // an enable runs at the spot too.
    // A rename too (round 13b): the display name reaches the prompts as the
    // user's name, so the narrow login holds no write of it.
    const credential =
      changes.role !== undefined ||
      changes.contactId !== undefined ||
      changes.disabledAt === null ||
      changes.displayName !== undefined;
    // A disable or a session end of the owner or an Admin user runs at the
    // spot too (0326: the narrow login may not move their disabled_at or
    // session epoch); onLoginHoldSpot asks the hold's own definer.
    const holdWrite = changes.disabledAt !== undefined || endSessions;
    const atCredentialSpot = (fn: () => Promise<void>) =>
      credential
        ? onFullSystemRoute('login-credential', fn)
        : holdWrite
          ? onLoginHoldSpot(targetId, fn)
          : fn();
    await atCredentialSpot(() =>
      db.transaction(async (tx) => {
        if (firstInTx) await firstInTx(tx);
        if (Object.keys(changes).length > 0) {
          await tx.update(authUsers).set(changes).where(eq(authUsers.id, targetId));
          // The role still names who is an Admin user (until W5c): keep the
          // Admin row in step, as the login bridge's trigger did before W5b2
          // turned it off (the function stays, 0261; Admin only since 0286:
          // a role change never touches another workspace's rows).
          if (changes.role !== undefined) {
            await tx.execute(sql`select "public"."mantle_bridge_login"(${targetId}::uuid)`);
          }
        }
        if (endSessions) {
          // The login's push devices go with its sessions; the relay is told
          // after the commit (pushTokens).
          await endLoginSessions(targetId, {
            tx,
            removedRoutingTokens: pushTokens,
            endKeys: true,
            actorId: actor.actor.id,
            revokedKeyIds: endedKeyIds,
            unboundPeerIds,
          });
        }
        // A member made admin: what they shared or submitted as a member goes
        // back to private drafts (audit F21). An admin's items are never team
        // drafts or reviewed, and a later demotion must not bring them back.
        if (promotes) await settleSpaceOnPromotion(tx, targetId);
        // Cookies re-read the row every request, so they stop at once. Bearers
        // and connector (OAuth) grants would too (both re-check the login), but
        // revoke them so the device and connector lists tell the truth. Unclaimed
        // pairing codes die too, so a QR shown before the lockout cannot pair.
        // The login's push devices go (0173): nothing else would stop the brain
        // pushing to its phone. Its personal assistant is released (kept, never
        // deleted): a member chats only with team-level agents.
        if (lockingOut) {
          pushTokens.push(...(await deleteLoginSubscriptions(targetId, tx)));
          releasedAgentId = (await releaseAssignedAgent(actor.id, targetId, tx))?.id ?? null;
          const now = new Date();
          await tx
            .update(mobileTokens)
            .set({ revokedAt: now })
            .where(and(eq(mobileTokens.userId, targetId), isNull(mobileTokens.revokedAt)));
          await tx
            .update(oauthAccessTokens)
            .set({ revokedAt: now })
            .where(
              and(eq(oauthAccessTokens.actorId, targetId), isNull(oauthAccessTokens.revokedAt)),
            );
          await tx.delete(oauthAuthCodes).where(eq(oauthAuthCodes.actorId, targetId));
          await tx
            .delete(pairingCodes)
            .where(and(eq(pairingCodes.userId, targetId), isNull(pairingCodes.claimedAt)));
        }
        if (inTx) await inTx(tx);
      }),
    );
  } catch (err) {
    // Two links to one contact at once: the check above passed for both, the
    // unique index (0181) stops the second.
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        status: 409,
        reason: 'contact-taken',
        error: 'That contact is already linked to another user.',
      };
    }
    if (isLastAdminRefusal(err)) {
      return { ok: false, status: 409, reason: 'last-admin', error: LAST_ADMIN_MESSAGE };
    }
    throw err;
  }
  // The login changed: a later guard read in this request finds it afresh
  // (A4 step 3a audit L1), now that the change is committed.
  forgetRequestLogins();
  // After the commit, as the single unpair route does: tell the relay.
  await forgetRelayDevices(pushTokens);
  // And record the API keys the end revoked (one row), now that it held.
  auditKeysEnded(targetId, actor.actor.id, endedKeyIds);
  // And each peer that acted as the login (access matrix L12, audit LOW-5).
  auditPeersUnbound(targetId, actor.actor.id, unboundPeerIds, 'sessions-ended');
  return {
    ok: true,
    sessionsEnded: endSessions,
    lockingOut,
    peersUnbound: unboundPeerIds.length,
    releasedAgentId,
    pushDevicesRemoved: pushTokens.length,
  };
}

/** The Admin workspace keeps at least one Moderator (workspaces 0241; the
 *  login bridge of 0251 makes every admin one): the database refuses, at
 *  commit, the change that would remove the last. Said plainly here. */
export const LAST_ADMIN_MESSAGE =
  'At least one admin must remain. Make another login an admin first, then try again.';

export function isLastAdminRefusal(err: unknown): boolean {
  if (!isCheckViolation(err)) return false;
  for (let e: unknown = err, d = 0; e && d < 4; d++) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.includes('at least one Moderator')) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
