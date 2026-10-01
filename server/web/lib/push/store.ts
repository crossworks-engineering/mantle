// Data access for push state. The instance token is sealed at rest with
// @mantle/crypto (AES-256-GCM under the master key); subscriptions hold the
// relay's routing token + the device's public key.

import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  authUsers,
  db,
  mobileTokens,
  pushInstance,
  pushLoginPrefs,
  pushPrefs,
  pushSubscriptions,
} from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { relayDeleteDevice } from './relay-client';

export interface PushInstanceSecret {
  instanceToken: string;
  relayInstanceId: string;
  relayUrl: string;
}

/** The single relay-identity row with the instance token decrypted, or null. */
export async function getPushInstance(): Promise<PushInstanceSecret | null> {
  const [row] = await db.select().from(pushInstance).limit(1);
  if (!row) return null;
  return {
    instanceToken: open(Buffer.from(row.instanceTokenEnc, 'base64')),
    relayInstanceId: row.relayInstanceId,
    relayUrl: row.relayUrl,
  };
}

/** Public status (no secret) for settings UI. */
export async function getPushInstanceMeta(): Promise<{
  relayUrl: string;
  connectedAt: Date;
} | null> {
  const [row] = await db
    .select({ relayUrl: pushInstance.relayUrl, connectedAt: pushInstance.connectedAt })
    .from(pushInstance)
    .limit(1);
  return row ?? null;
}

/** Upsert the singleton relay identity (encrypts the instance token). */
export async function savePushInstance(args: PushInstanceSecret): Promise<void> {
  const instanceTokenEnc = seal(args.instanceToken).ciphertext.toString('base64');
  await db
    .insert(pushInstance)
    .values({
      instanceTokenEnc,
      relayInstanceId: args.relayInstanceId,
      relayUrl: args.relayUrl,
      singleton: true,
    })
    .onConflictDoUpdate({
      target: pushInstance.singleton,
      set: {
        instanceTokenEnc,
        relayInstanceId: args.relayInstanceId,
        relayUrl: args.relayUrl,
        connectedAt: new Date(),
      },
    });
}

export interface DeviceRow {
  id: string;
  routingToken: string;
  publicKey: string;
  platform: 'ios' | 'android';
  label: string | null;
}

const DEVICE_COLUMNS = {
  id: pushSubscriptions.id,
  routingToken: pushSubscriptions.routingToken,
  publicKey: pushSubscriptions.publicKey,
  platform: pushSubscriptions.platform,
  label: pushSubscriptions.label,
};

/** The device token that enrolled the device is still live (0211). */
const tokenLive = () => and(isNull(mobileTokens.revokedAt), gt(mobileTokens.expiresAt, sql`now()`));

// There is deliberately NO "every device of this brain" list for the send
// path. Before 0211 pushOutbound and pushApproval used one, and a member's or
// a client's device, once enrolled, would have received the owner's assistant
// teasers. Every send names the logins it is for: the admins
// (listAdminSubscriptions) or ONE member or client (listLoginSubscriptions).

/**
 * The devices of ACTIVE ADMIN logins only: the owner's assistant messages,
 * approvals and the "needs you" notices are never a member's or a client's
 * business. Fails closed: a device with no login on record, or whose login is
 * a member, a client or deactivated, is left out; so is a device whose own
 * token was revoked or expired (a device enrolled before 0211 has no token on
 * record and keeps the login-level rule). `loginId` narrows to ONE admin (an
 * agent assigned to that login).
 */
export async function listAdminSubscriptions(
  ownerId: string,
  opts: { loginId?: string | null } = {},
): Promise<DeviceRow[]> {
  const rows = await db
    .select(DEVICE_COLUMNS)
    .from(pushSubscriptions)
    .innerJoin(authUsers, eq(authUsers.id, pushSubscriptions.loginId))
    .leftJoin(mobileTokens, eq(mobileTokens.id, pushSubscriptions.tokenId))
    .where(
      and(
        eq(pushSubscriptions.ownerId, ownerId),
        eq(authUsers.role, 'admin'),
        isNull(authUsers.disabledAt),
        or(isNull(pushSubscriptions.tokenId), tokenLive()),
        ...(opts.loginId ? [eq(pushSubscriptions.loginId, opts.loginId)] : []),
      ),
    );
  return rows as DeviceRow[];
}

/**
 * The devices of ONE member or client login, for a push that concerns that
 * login alone (0211). Fails closed on every side: the login must be an
 * active member or client, the device must carry the token that enrolled it,
 * that token must belong to the same login and be live. A signed-out,
 * revoked or expired phone gets nothing; an admin's device is never here.
 */
export async function listLoginSubscriptions(
  ownerId: string,
  loginId: string,
): Promise<DeviceRow[]> {
  const rows = await db
    .select(DEVICE_COLUMNS)
    .from(pushSubscriptions)
    .innerJoin(authUsers, eq(authUsers.id, pushSubscriptions.loginId))
    .innerJoin(mobileTokens, eq(mobileTokens.id, pushSubscriptions.tokenId))
    .where(
      and(
        eq(pushSubscriptions.ownerId, ownerId),
        eq(pushSubscriptions.loginId, loginId),
        inArray(authUsers.role, ['member', 'client']),
        isNull(authUsers.disabledAt),
        eq(mobileTokens.userId, loginId),
        tokenLive(),
      ),
    );
  return rows as DeviceRow[];
}

/** The settings list for an ADMIN: the brain's devices that are not a
 *  member's or a client's (metadata only; never used to send). */
export async function listAdminDeviceList(ownerId: string): Promise<DeviceRow[]> {
  const rows = await db
    .select(DEVICE_COLUMNS)
    .from(pushSubscriptions)
    .leftJoin(authUsers, eq(authUsers.id, pushSubscriptions.loginId))
    .where(
      and(
        eq(pushSubscriptions.ownerId, ownerId),
        or(isNull(pushSubscriptions.loginId), eq(authUsers.role, 'admin')),
      ),
    );
  return rows as DeviceRow[];
}

export type OwnDevice = Pick<DeviceRow, 'id' | 'platform' | 'label'> & { tokenId: string | null };

/** One login's own devices, for its settings list: those it enrolled with a
 *  token that is still live. `tokenId` marks the calling device. */
export async function listOwnDevices(loginId: string): Promise<OwnDevice[]> {
  const rows = await db
    .select({
      id: pushSubscriptions.id,
      platform: pushSubscriptions.platform,
      label: pushSubscriptions.label,
      tokenId: pushSubscriptions.tokenId,
    })
    .from(pushSubscriptions)
    .innerJoin(mobileTokens, eq(mobileTokens.id, pushSubscriptions.tokenId))
    .where(
      and(eq(pushSubscriptions.loginId, loginId), eq(mobileTokens.userId, loginId), tokenLive()),
    );
  return rows as OwnDevice[];
}

export async function insertSubscription(args: {
  ownerId: string;
  /** The login that enrolled the device (0173): its lockout unpairs it. */
  loginId: string;
  /** The device token the caller authenticated with (0211), when it did so
   *  by bearer: the device is pushed to only while that token is live. */
  tokenId?: string | null;
  routingToken: string;
  publicKey: string;
  platform: 'ios' | 'android';
  label?: string | null;
  relayDeviceId?: string | null;
}): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    // One phone belongs to one login: a routing token enrolled again (the
    // same app signed in as someone else, or the same login once more)
    // replaces the row it had, whoever held it.
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.routingToken, args.routingToken));
    const [row] = await tx
      .insert(pushSubscriptions)
      .values({
        ownerId: args.ownerId,
        loginId: args.loginId,
        tokenId: args.tokenId ?? null,
        routingToken: args.routingToken,
        publicKey: args.publicKey,
        platform: args.platform,
        label: args.label ?? null,
        relayDeviceId: args.relayDeviceId ?? null,
      })
      .returning({ id: pushSubscriptions.id });
    return row!;
  });
}

/** Delete one device (scoped to owner); returns its routing token for relay cleanup. */
export async function deleteSubscription(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.ownerId, ownerId)))
    .returning({ routingToken: pushSubscriptions.routingToken });
  return row?.routingToken ?? null;
}

/** Delete one of a LOGIN's own devices (a member or a client unpairs its
 *  phone); returns its routing token for relay cleanup, null when the device
 *  is not that login's. */
export async function deleteOwnSubscription(loginId: string, id: string): Promise<string | null> {
  const [row] = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.loginId, loginId)))
    .returning({ routingToken: pushSubscriptions.routingToken });
  return row?.routingToken ?? null;
}

/** Delete the devices one device token enrolled (that token signed out);
 *  returns their routing tokens for {@link forgetRelayDevices}. */
export async function deleteTokenSubscriptions(tokenId: string): Promise<string[]> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(and(isNotNull(pushSubscriptions.tokenId), eq(pushSubscriptions.tokenId, tokenId)))
    .returning({ routingToken: pushSubscriptions.routingToken });
  return rows.map((r) => r.routingToken);
}

/** Delete all of an owner's devices (used by reset); returns their routing tokens. */
export async function deleteAllSubscriptions(ownerId: string): Promise<string[]> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerId, ownerId))
    .returning({ routingToken: pushSubscriptions.routingToken });
  return rows.map((r) => r.routingToken);
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Delete every device one LOGIN enrolled (its lockout, or just before the
 *  login is deleted, where the FK cascade alone would not tell the relay).
 *  Returns their routing tokens for {@link forgetRelayDevices}. */
export async function deleteLoginSubscriptions(
  loginId: string,
  exec: Executor = db,
): Promise<string[]> {
  const rows = await exec
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.loginId, loginId))
    .returning({ routingToken: pushSubscriptions.routingToken });
  return rows.map((r) => r.routingToken);
}

/** Best-effort: tell the relay to drop these devices, as the single unpair
 *  route does. Fire and forget; the local rows are already gone, so a device
 *  the relay keeps can no longer be addressed by this brain anyway. */
export async function forgetRelayDevices(routingTokens: string[]): Promise<void> {
  if (routingTokens.length === 0) return;
  const instance = await getPushInstance();
  if (!instance) return;
  for (const token of routingTokens) {
    void relayDeleteDevice(instance.relayUrl, instance.instanceToken, token);
  }
}

/** Drop a device by routing token (worker cleanup on a 410 from the relay). */
export async function deleteSubscriptionByRoutingToken(routingToken: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.routingToken, routingToken));
}

export async function markPushed(id: string): Promise<void> {
  // Called fire-and-forget (`void markPushed(...)`) from the delivery loop, so
  // swallow transient DB errors here rather than surfacing an unhandled
  // rejection that could crash the worker mid-batch. lastPushAt is a
  // best-effort recency marker; a missed update is harmless.
  try {
    await db
      .update(pushSubscriptions)
      .set({ lastPushAt: new Date() })
      .where(eq(pushSubscriptions.id, id));
  } catch (err) {
    console.error('[push] markPushed failed (non-fatal):', err);
  }
}

// --- Preferences (single row; per-trigger toggles) ---

export interface PushPreferences {
  assistantMessages: boolean;
  approvals: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPreferences = {
  assistantMessages: true,
  approvals: true,
};

export async function getPushPrefs(): Promise<PushPreferences> {
  const [row] = await db.select().from(pushPrefs).limit(1);
  if (!row) return DEFAULT_PUSH_PREFS;
  return {
    assistantMessages: row.assistantMessages,
    approvals: row.approvals,
  };
}

export async function updatePushPrefs(patch: Partial<PushPreferences>): Promise<PushPreferences> {
  const next = { ...(await getPushPrefs()), ...patch };
  await db
    .insert(pushPrefs)
    .values({ ...next, singleton: true })
    .onConflictDoUpdate({ target: pushPrefs.singleton, set: next });
  return next;
}

// --- Per-login preferences (a member or a client; 0211) ---

export interface LoginPushPreferences {
  /** A reply in the login's own chat thread. */
  chatReplies: boolean;
  /** An own item accepted, returned or taken over. */
  reviewResults: boolean;
  /** A comment on an own item, or on an item shared with a client. */
  comments: boolean;
}

export const DEFAULT_LOGIN_PUSH_PREFS: LoginPushPreferences = {
  chatReplies: true,
  reviewResults: true,
  comments: true,
};

/** One login's toggles; all on when it never changed one. */
export async function getLoginPushPrefs(loginId: string): Promise<LoginPushPreferences> {
  const [row] = await db
    .select()
    .from(pushLoginPrefs)
    .where(eq(pushLoginPrefs.loginId, loginId))
    .limit(1);
  if (!row) return DEFAULT_LOGIN_PUSH_PREFS;
  return { chatReplies: row.chatReplies, reviewResults: row.reviewResults, comments: row.comments };
}

export async function updateLoginPushPrefs(
  loginId: string,
  patch: Partial<LoginPushPreferences>,
): Promise<LoginPushPreferences> {
  const next = { ...(await getLoginPushPrefs(loginId)), ...patch };
  await db
    .insert(pushLoginPrefs)
    .values({ loginId, ...next })
    .onConflictDoUpdate({
      target: pushLoginPrefs.loginId,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}
