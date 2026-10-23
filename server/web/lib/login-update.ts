import { z } from 'zod';
import { LOGIN_ROLES, isLoginRole, type LoginRole } from '@mantle/client-types/role-names';
import {
  isCheckViolation,
  isUniqueViolation,
  pgErrorCode,
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
import { liveAdminWorkspace, loginRole } from '@/lib/auth/admin-seat';

/**
 * One change to a login row (PATCH /api/users/:id), and the role change the
 * Admin workspace's user list makes. Membership decides the role: a role
 * change is an add to or a removal from the Admin workspace through its
 * membership definers (mantle_ws_add_user, mantle_ws_remove_user), which
 * write auth.users.role in the same transaction; nothing here writes the
 * role. Both paths end the same sessions, settle the same drafts and lock
 * the same devices out.
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

/** The login row a change is about, or null. Its `role` is the one Admin
 *  membership gives (loginRole: 'admin' for a user of the live
 *  Admin workspace, else 'member'; S8b), never the column: a change is
 *  decided from membership, so a row whose column drifted is put right by
 *  the role change that names what membership should be. */
export async function loadLoginTarget(id: string): Promise<LoginTarget | null> {
  const [row] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      isOwner: authUsers.isOwner,
      role: loginRole(authUsers.id),
    })
    .from(authUsers)
    .where(eq(authUsers.id, id))
    .limit(1);
  return row ?? null;
}

export type LoginTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Apply `change` to `target` for `actor`. `change.role` is the role the
 * change makes (it ends the sessions, locks a demoted login out, settles a
 * promoted login's space); the role column itself is written only by the
 * membership definer the caller runs in `firstInTx` or `inTx`. `inTx` runs
 * last inside the same transaction (the workspace screen writes its own
 * rows there). `firstInTx` runs first in it, before any write: the
 * workspace screen locks the workspace and checks its rules there (W5a
 * audit L2), and the Users screen adds to or removes from Admin there.
 * What a callback throws ends the transaction and is thrown on.
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
  const toAdmin = change.role === 'admin';
  const lockingOut = (change.role !== undefined && !toAdmin) || change.disabled === true;
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
    // table) in this transaction: at the spot below the caller's own
    // statements run (settlePromotionOnNarrow answers null off the narrow
    // route).
    // A role change or a contact link writes a rights column the narrow
    // login may not (a role change is an add to or a removal from Admin by
    // its membership definer, which writes auth.users role and asks the
    // exit's acting login, the caller, with no scope; auth.users
    // contact_id: a contact's shares reach the login linked to it): the
    // whole transaction then runs at the full-route spot login-credential
    // (docs/runtime-role.md); any other change stays on the exit's own
    // route. The role change is keyed on what membership gives the target
    // (target.role, loadLoginTarget), so a request naming the role the
    // login already has changes nothing and needs no spot. An enable
    // (disabled_at back to NULL) lets the login in again: the narrow login
    // may only set disabled_at (0319), so an enable runs at the spot too.
    // A rename too (round 13b): the display name reaches the prompts as the
    // user's name, so the narrow login holds no write of it.
    const roleChange = change.role !== undefined && change.role !== target.role;
    // Only a real promotion settles (a login already admin by membership
    // was settled when it was made one, and an admin's items are never team
    // drafts), so the settle runs at the spot below, never on the narrow
    // route, whose role may not run its definer.
    const promotes = roleChange && toAdmin;
    const credential =
      roleChange ||
      changes.contactId !== undefined ||
      changes.disabledAt === null ||
      changes.displayName !== undefined;
    // A disable or a session end of the owner or an Admin user runs at the
    // spot too (0327: the narrow login may not move their disabled_at or
    // session epoch); onLoginHoldSpot asks the hold's own definer. So does a
    // lockout with no role change (a request naming the role 'member' a
    // login already has): its token, device and code writes are held for
    // such a login too (0327, 0328).
    const holdWrite = changes.disabledAt !== undefined || endSessions || lockingOut;
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

/**
 * The Users screen's role change, as Admin membership (PATCH /api/users/:id
 * with a role): `toAdmin` (the role 'admin') adds the login to the brain's
 * live Admin workspace (a Moderator there, as every Admin user); any other
 * role removes it, each through the membership definer, which checks the
 * caller (an Admin user with the users area: the scope's login, or with no
 * scope the exit's acting login the gateway sends) and writes the role
 * column. A login already where the role puts it is left as it is. Run in
 * applyLoginChange's `firstInTx`, at the full-route spot login-credential
 * (a role change's), on the system pool.
 */
export async function adminMembershipChange(
  tx: LoginTx,
  targetId: string,
  toAdmin: boolean,
): Promise<void> {
  const admin = await liveAdminWorkspace(tx, targetId);
  if (!admin) {
    throw new Error('adminMembershipChange: the brain has no live Admin workspace');
  }
  if (toAdmin === admin.member) return;
  // A savepoint (drizzle's nested transaction: the driver's own, which the
  // narrow route lets through where it refuses SAVEPOINT text), so a
  // concurrent change that got there first (the definer's "already a user"
  // or "not a user", read after that change committed) is a no-op here
  // rather than the end of the whole change: the login is where this change
  // puts it either way.
  const call = toAdmin
    ? sql`select "public"."mantle_ws_add_user"(${admin.owner}::uuid, ${admin.ws}::uuid, ${targetId}::uuid, true)`
    : sql`select "public"."mantle_ws_remove_user"(${admin.owner}::uuid, ${admin.ws}::uuid, ${targetId}::uuid)`;
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(call);
    });
  } catch (err) {
    if (definerRefusal(err) !== (toAdmin ? 'already_user' : 'not_user')) throw err;
  }
}

/** The membership definer's refusal code in `err` (the word after
 *  `mantle_ws:` in its message, e.g. 'last_moderator'), or null. */
export function definerRefusal(err: unknown): string | null {
  for (let e: unknown = err, d = 0; e && d < 4; d++) {
    const m = (e as { message?: unknown }).message;
    const hit = typeof m === 'string' ? /^mantle_ws:([a-z_]+)\b/.exec(m) : null;
    if (hit) return hit[1]!;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The caller refusals of the membership definers that carry no 42501:
 *  the caller is no user of the workspace (P0002 `not_found`, the seat
 *  lookup), and the two the exit's acting login raises (42501 already, kept
 *  by name so the answer never hangs on the SQLSTATE alone). */
const CALLER_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'no_acting_login', 'read_only']);

/** The caller refusals that mean the spot's wiring, not the caller, may be
 *  wrong: the definer found no acting login (the gateway sends one at
 *  `login-credential` in every check mode) or no user row for it. Still a
 *  403, but said in the log by its code, so a regression there is seen. */
const WIRING_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'no_acting_login']);

/** The refusals that say the caller lacks the users area. */
const USERS_AREA_REFUSALS: ReadonlySet<string> = new Set([
  'admin_users_only',
  'admin_only',
  'forbidden',
]);

/** The answer for a membership definer's refusal of the Users screen's
 *  role change or admin login create, or null for any other error: the
 *  last Moderator of Admin is the old last-admin 409; a caller the definer
 *  refuses is a 403, not a 500: any `mantle_ws:` refusal with SQLSTATE
 *  42501, and the caller's own not_found, no_acting_login and read_only.
 *  The one mapper of both routes (PATCH /api/users/[id], POST /api/users). */
export function adminMembershipRefusal(
  err: unknown,
): { status: 403 | 409; reason: string; error: string } | null {
  const code = definerRefusal(err);
  if (code === null) return null;
  if (code === 'last_moderator') {
    return { status: 409, reason: 'last-admin', error: LAST_ADMIN_MESSAGE };
  }
  if (USERS_AREA_REFUSALS.has(code)) {
    return {
      status: 403,
      reason: 'users-area',
      error: 'Changing who is an admin needs the users area.',
    };
  }
  if (CALLER_REFUSALS.has(code) || pgErrorCode(err) === '42501') {
    if (WIRING_REFUSALS.has(code)) {
      console.warn(
        `[users] admin membership refused mantle_ws:${code}: answered 403; check the login-credential spot sends the acting login`,
      );
    }
    return {
      status: 403,
      reason: 'forbidden',
      error: 'You may not change who is an admin.',
    };
  }
  return null;
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
