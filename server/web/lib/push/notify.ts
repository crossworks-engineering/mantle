// The send path: given an outbound conversation turn (or a pending approval),
// seal a teaser to each ADMIN device and hand it to the relay — gated by the
// owner's per-trigger toggles (push-notifications.md §10). Everything here is
// the owner's side of the brain, so it goes to the devices of active admin
// logins and to no other device: a member's or a client's phone never gets
// an owner teaser (their own pushes are login-notify.ts). Quiet
// hours were removed (docs/reminder-delivery-routing.md §C); OS-level Do Not
// Disturb handles night muting. Pure server logic, shared by the push-notify
// worker. Content never leaves here unsealed.

import { createHmac } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, agents, assistantMessages } from '@mantle/db';
import { markdownPreview } from '@mantle/content-core/markdown-to-text';
import { countPending, listPendingCalls } from '@mantle/tools';
import { loadNeedsYou, loadProfilePreferences } from '@mantle/content';
import { needsYouArrivals, needsYouMessage, rememberArrivals } from './needs-you';
import { errorMessage } from '@mantle/std';
import { derivedSecret } from '../auth/tokens';
import { publicKeyValid, sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import {
  deleteSubscriptionByRoutingToken,
  getPushInstance,
  getPushPrefs,
  listAdminSubscriptions,
  markPushed,
  type DeviceRow,
  type PushInstanceSecret,
} from './store';

/** The plaintext that gets sealed to the device (push-notifications.md §6).
 *  `kind`, `itemId` and `state` are set on a member's or a client's pushes
 *  only (login-notify.ts); an owner push carries none of them. */
export interface PushPayload {
  v: 1;
  t: string; // title (agent name, or "Mantle")
  b: string; // body (teaser)
  agentSlug?: string;
  deepLink: string;
  ts: number;
  kind?: 'chat' | 'review' | 'comment';
  itemId?: string;
  state?: 'accepted' | 'returned' | 'taken';
}

export interface PushResult {
  attempted: number;
  delivered: number;
  dropped: number; // unregistered devices removed
  skipped?: 'not_connected' | 'no_devices' | 'no_message' | 'disabled' | 'wrong_channel';
}

/** A reply as a lock-screen line: plain words (a reply is markdown, and a
 *  notification renders none of it), one line, cut after the marks are gone.
 *  Never empty: a reply with no words (a picture only) says so. */
function teaser(text: string, max = 140): string {
  return markdownPreview(text, max) || 'New message';
}

async function latestOutbound(
  ownerId: string,
  agentSlug: string,
): Promise<{ agentName: string; text: string; assignedUserId: string | null } | null> {
  const [agent] = await db
    .select({ id: agents.id, name: agents.name, assignedUserId: agents.assignedUserId })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!agent) return null;

  const [msg] = await db
    .select({ text: assistantMessages.text })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agent.id),
        eq(assistantMessages.direction, 'outbound'),
        // The durable runner inserts the reply row 'pending' with empty text
        // and fills it on finalize (migration 0105). Never teaser a placeholder.
        eq(assistantMessages.status, 'complete'),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt))
    .limit(1);
  if (!msg) return null;
  return { agentName: agent.name, text: msg.text, assignedUserId: agent.assignedUserId ?? null };
}

/** The most devices one send walks. A login holds at most ten
 *  (MAX_DEVICES_PER_LOGIN), so only a brain with many admins comes near it;
 *  the bound is what keeps one event from holding the chain. */
export const MAX_DEVICES_PER_SEND = 100;

/** A member's or a client's collapse key as the relay sees it: 32 hex
 *  characters, keyed by a secret the relay never holds, per login. */
export function opaqueCollapseKey(loginId: string, collapseKey: string): string {
  return createHmac('sha256', derivedSecret('push-collapse-key'))
    .update(`${loginId}\n${collapseKey}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Seal `payload` to each device and forward to the relay. Prunes a device
 * the relay says it does not know (relay-client: 410, or 404
 * `unknown_device`) and one whose stored public key is not a key at all
 * (publicKeyValid: it could never be sent to). Any other seal failure (a
 * libsodium that failed to load) skips the device and logs: it says nothing
 * about the device.
 *
 * `opaqueFor` (a member's or a client's push, the login's id): the collapse
 * key goes out as a keyed hash of the login and the key, under a secret only
 * this brain holds (derivedSecret). The relay and the push provider see
 * neither the kind of event nor an item id, cannot compute the hash
 * themselves, and cannot link one login's keys to another's.
 */
export async function sendToDevices(
  instance: PushInstanceSecret,
  devices: DeviceRow[],
  payload: PushPayload,
  collapseKey: string,
  opts: { opaqueFor?: string } = {},
): Promise<{ delivered: number; dropped: number }> {
  const plaintext = JSON.stringify(payload);
  const key = opts.opaqueFor ? opaqueCollapseKey(opts.opaqueFor, collapseKey) : collapseKey;
  let delivered = 0;
  let dropped = 0;
  for (const device of devices.slice(0, MAX_DEVICES_PER_SEND)) {
    if (!publicKeyValid(device.publicKey)) {
      // Not a key: it never gets better, and it should not break the others.
      dropped++;
      await deleteSubscriptionByRoutingToken(device.routingToken);
      continue;
    }
    let ciphertext: string;
    try {
      ciphertext = await sealToDevice(device.publicKey, plaintext);
    } catch (err) {
      // The key is well formed, so the failure is ours (libsodium): skip,
      // never prune.
      console.error(`[push] seal failed, device skipped: ${errorMessage(err)}`);
      continue;
    }
    const res = await relayNotify(instance.relayUrl, instance.instanceToken, {
      routingToken: device.routingToken,
      ciphertext,
      collapseKey: key,
    });
    if (res.ok) {
      delivered++;
      void markPushed(device.id);
    } else if (res.unregistered) {
      dropped++;
      await deleteSubscriptionByRoutingToken(device.routingToken);
    }
  }
  return { delivered, dropped };
}

/**
 * Should a `conversation_changed` NOTIFY trigger an outbound push? Only a
 * finished outbound turn: the trigger (migration 0156) fires on the 'pending'
 * insert AND on the finalize update, and carries `status` so the two can be
 * told apart. A payload with no status comes from the pre-0156 trigger shape
 * (rows inserted already 'complete') and is treated as complete.
 */
export function wantsOutboundPush(c: { direction?: string; status?: string | null }): boolean {
  if (c.direction !== 'outbound') return false;
  return c.status == null || c.status === 'complete';
}

/**
 * Push the latest outbound turn for {ownerId, agentSlug} to the ADMIN
 * devices, unless the assistant-messages trigger is off. Never to a
 * member's or a client's device: the owner's conversation is the admins'.
 *
 * An agent assigned to one login (agents.assigned_user_id: that admin's own
 * assistant) pushes to that login's devices only; the other admins can open
 * the thread, but it is not their conversation and their phones stay quiet.
 * An agent assigned to nobody pushes to every active admin.
 */
export async function pushOutbound(ownerId: string, agentSlug: string): Promise<PushResult> {
  const instance = await getPushInstance();
  if (!instance) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' };

  const prefs = await getPushPrefs();
  if (!prefs.assistantMessages)
    return { attempted: 0, delivered: 0, dropped: 0, skipped: 'disabled' };

  const msg = await latestOutbound(ownerId, agentSlug);
  if (!msg) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_message' };

  const devices = await listAdminSubscriptions(ownerId, { loginId: msg.assignedUserId });
  if (devices.length === 0)
    return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_devices' };

  const payload: PushPayload = {
    v: 1,
    t: msg.agentName,
    b: teaser(msg.text),
    agentSlug,
    deepLink: `/chat/${agentSlug}`,
    ts: Date.now(),
  };
  const { delivered, dropped } = await sendToDevices(instance, devices, payload, agentSlug);
  return { attempted: devices.length, delivered, dropped };
}

/**
 * Push a pending-approval nudge to the ADMIN devices — unless the approvals
 * trigger is off, or the operator's last communication channel isn't the
 * companion app. Approvals follow `reminderChannel` (the sticky last-channel
 * signal, see docs/reminder-delivery-routing.md): a `telegram`/unset operator
 * gets the Telegram notice instead (pending-notify.ts), so pushing here too
 * would double-notify. Only the `mobile` channel routes to a device push.
 * Collapses on "approvals" so repeated nudges supersede.
 */
export async function pushApproval(ownerId: string): Promise<PushResult> {
  const instance = await getPushInstance();
  if (!instance) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' };

  const prefs = await getPushPrefs();
  if (!prefs.approvals) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'disabled' };

  const profile = await loadProfilePreferences(ownerId);
  if (profile.reminderChannel !== 'mobile') {
    return { attempted: 0, delivered: 0, dropped: 0, skipped: 'wrong_channel' };
  }

  const devices = await listAdminSubscriptions(ownerId);
  if (devices.length === 0)
    return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_devices' };

  const count = await countPending(ownerId);
  if (count === 0) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_message' };

  // A runner QUESTION gets its text on the lock screen. "An action needs your
  // approval" is fine for a confirm-gated tool — the operator taps through and
  // sees what it was — but a parked run is blocking until answered, and
  // knowing WHICH decision is waiting is what makes it worth stopping for.
  const newest = (await listPendingCalls(ownerId, { status: 'pending', limit: 1 }))[0];
  const question =
    newest?.toolSlug === 'ask_human'
      ? ((newest.args?.['question'] as string | undefined)?.trim() ?? '')
      : '';
  // The question is the agent's own words, so it may be markdown: plain
  // words only (empty after that reads as no question).
  const asked = question ? markdownPreview(question, count === 1 ? 120 : 100) : '';
  const body = asked
    ? count === 1
      ? `A run needs your answer: ${asked}`
      : `${asked} (+${count - 1} more waiting)`
    : count === 1
      ? 'An action needs your approval.'
      : `${count} actions need your approval.`;

  const payload: PushPayload = {
    v: 1,
    t: 'Mantle',
    b: body,
    deepLink: '/pending',
    ts: Date.now(),
  };
  const { delivered, dropped } = await sendToDevices(instance, devices, payload, 'approvals');
  return { attempted: devices.length, delivered, dropped };
}

/**
 * Push a "needs you" notice (a member submitted an item for review, or filed
 * a team request) to the devices of ACTIVE ADMIN logins only, never a
 * member's. Only an arrival pushes (see needsYouArrivals): the same NOTIFY
 * fires when something leaves a queue. `seen` is the caller's per-process
 * memory of what was pushed; the caller runs one call at a time. Title and
 * author only, never content (and sealed to the device like every push).
 * Gated by the approvals toggle ("things waiting for you"); unlike an
 * approval it does not follow reminderChannel: there is no Telegram card for
 * it to double. Collapses on "needs-you" so a newer notice replaces an older.
 */
export async function pushNeedsYou(
  ownerId: string,
  seen: Set<string>,
  now = Date.now(),
): Promise<PushResult> {
  const instance = await getPushInstance();
  if (!instance) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' };

  const prefs = await getPushPrefs();
  if (!prefs.approvals) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'disabled' };

  const n = await loadNeedsYou(ownerId);
  const arrivals = needsYouArrivals(n, seen, now);
  if (arrivals.length === 0) {
    return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_message' };
  }
  // Remembered before sending: a failed send is not retried by the next event.
  rememberArrivals(seen, arrivals);

  const devices = await listAdminSubscriptions(ownerId);
  if (devices.length === 0)
    return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_devices' };

  const m = needsYouMessage(arrivals[0]!, n.total);
  const payload: PushPayload = { v: 1, t: m.title, b: m.body, deepLink: m.deepLink, ts: now };
  const { delivered, dropped } = await sendToDevices(instance, devices, payload, 'needs-you');
  return { attempted: devices.length, delivered, dropped };
}
