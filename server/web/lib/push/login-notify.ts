// The send path for a MEMBER's or a CLIENT's own pushes (migration mobile_roles_push,
// docs/mobile-companion-backend.md "Three roles on the phone"): a reply in
// its chat thread, a review result on its item, a new comment. Each message
// is for ONE login (@mantle/content login-notices.ts decides who and with
// which words) and goes to that login's live devices only, sealed like every
// push. An admin's device is never a target here, and an owner teaser never
// comes through here. Pure send logic, no LLM work.

import {
  chatReplyNotice,
  commentNotices,
  reviewResultNotice,
  type LoginNotice,
  type LoginNoticeMessage,
} from '@mantle/content';
import { sendToDevices, type PushContent, type PushResult } from './notify';
import {
  getLoginPushPrefs,
  getPushInstance,
  listLoginSubscriptions,
  type LoginPushPreferences,
} from './store';

const PREF_OF: Record<LoginNoticeMessage['kind'], keyof LoginPushPreferences> = {
  chat: 'chatReplies',
  review: 'reviewResults',
  comment: 'comments',
};

const skipped = (reason: NonNullable<PushResult['skipped']>): PushResult => ({
  attempted: 0,
  delivered: 0,
  dropped: 0,
  skipped: reason,
});

/** Send one message to the devices of the login it is for, unless that login
 *  switched the trigger off. */
export async function pushToLogin(
  m: LoginNoticeMessage | null,
  now = Date.now(),
): Promise<PushResult> {
  if (!m) return skipped('no_message');
  const instance = await getPushInstance();
  if (!instance) return skipped('not_connected');
  const prefs = await getLoginPushPrefs(m.loginId);
  if (!prefs[PREF_OF[m.kind]]) return skipped('disabled');
  const devices = await listLoginSubscriptions(m.ownerId, m.loginId);
  if (devices.length === 0) return skipped('no_devices');
  const payload: PushContent = {
    v: 1,
    t: m.title,
    b: m.body,
    deepLink: m.deepLink,
    ts: now,
    kind: m.kind,
    ...(m.itemId ? { itemId: m.itemId } : {}),
    ...(m.state ? { state: m.state } : {}),
  };
  const { delivered, dropped } = await sendToDevices(instance, devices, payload, m.collapseKey, {
    opaqueFor: m.loginId,
  });
  return { attempted: devices.length, delivered, dropped };
}

/** A finished reply in a login's own chat thread. */
export async function pushChatReply(
  n: Extract<LoginNotice, { kind: 'chat' }>,
  now = Date.now(),
): Promise<PushResult> {
  return pushToLogin(await chatReplyNotice(n), now);
}

/** A review result on an author's item (or its bundle: one push). */
export async function pushReviewResult(
  loginId: string,
  state: Extract<LoginNotice, { kind: 'review' }>['state'],
  nodeIds: readonly string[],
  now = Date.now(),
): Promise<PushResult> {
  return pushToLogin(await reviewResultNotice(loginId, state, nodeIds), now);
}

/** A new comment: one push per login it concerns. */
export async function pushComment(commentId: string, now = Date.now()): Promise<PushResult> {
  const total: PushResult = { attempted: 0, delivered: 0, dropped: 0 };
  const messages = await commentNotices(commentId);
  if (messages.length === 0) return skipped('no_message');
  // commentNotices bounds how many logins one comment tells
  // (MAX_LOGINS_PER_NOTICE); each holds at most ten devices.
  for (const m of messages) {
    const r = await pushToLogin(m, now);
    total.attempted += r.attempted;
    total.delivered += r.delivered;
    total.dropped += r.dropped;
  }
  return total;
}
