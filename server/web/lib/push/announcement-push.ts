// The push of a Control Center broadcast (docs/control-center.md
// "Broadcast"): one push to each live member of the box's Announcements
// group who did not mute it, on that login's own devices (an Admin's from
// listAdminSubscriptions, a member's from listLoginSubscriptions), sealed
// like every push. The text is the line itself, which every member may
// open. No LLM work.
//
// The messenger's own push (login_notice kind 'message') is not sent yet
// (docs/messenger.md "Live delivery"); this is the broadcast's alone.

import { messengerParticipantLogins } from '@mantle/content/messenger';
import { markdownPreview } from '@mantle/content-core/markdown-to-text';
import { sendToDevices, type PushResult } from './notify';
import {
  getPushInstance,
  listAdminSubscriptions,
  listLoginSubscriptions,
  type DeviceRow,
} from './store';

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

export async function pushAnnouncement(
  ownerId: string,
  a: { conversationId: string; seq: number; title: string | null; body: string },
  now = Date.now(),
): Promise<PushResult> {
  const instance = await getPushInstance();
  if (!instance) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' };
  const told = (await messengerParticipantLogins(a.conversationId)).filter(
    (p) => p.leftSeq === null && !p.muted,
  );
  const admins = new Map<string, DeviceRow[]>();
  for (const d of await listAdminSubscriptions(ownerId)) {
    if (d.loginId) admins.set(d.loginId, [...(admins.get(d.loginId) ?? []), d]);
  }
  const link = `/chats/${a.conversationId}`;
  const content = {
    v: 1 as const,
    t: clip(a.title ?? 'Announcement', 80),
    b: clip(markdownPreview(a.body, 180), 180),
    deepLink: link,
    itemLink: link,
    ts: now,
  };
  let attempted = 0;
  let delivered = 0;
  let dropped = 0;
  for (const p of told) {
    const devices = admins.get(p.loginId) ?? (await listLoginSubscriptions(ownerId, p.loginId));
    if (devices.length === 0) continue;
    attempted += devices.length;
    const r = await sendToDevices(instance, devices, content, `announcement:${a.seq}`, {
      opaqueFor: p.loginId,
    });
    delivered += r.delivered;
    dropped += r.dropped;
  }
  return { attempted, delivered, dropped };
}
