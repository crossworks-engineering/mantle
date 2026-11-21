/**
 * The subject box's side of a Control Center broadcast (docs/control-center.md
 * "Broadcast"): the `broadcast` case of the signed route (box.ts), behind its
 * signature check. The line goes into the box's one Announcements group
 * (@mantle/content/messenger announcementLine), and each member who did not
 * mute the group gets a push (lib/push/announcement-push.ts), after the line
 * is stored and without holding the CC's call.
 *
 * Idempotent by the broadcast id: a second call writes nothing and sends no
 * push (`was: 'already'`). A system line starts no agent turn.
 */
import { z } from 'zod';
import { announcementLine } from '@mantle/content/messenger';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { CONTROL_BROADCAST_BODY_MAX, CONTROL_BROADCAST_TITLE_MAX } from '@mantle/db/schema';
import { pushAnnouncement } from '@/lib/push/announcement-push';

/** The call, as box.ts's switch takes it. */
export const BROADCAST_CALL = z
  .object({
    op: z.literal('broadcast'),
    args: z
      .object({
        id: z.string().uuid(),
        title: z.string().max(CONTROL_BROADCAST_TITLE_MAX),
        body: z.string().trim().min(1).max(CONTROL_BROADCAST_BODY_MAX),
        by: z.string().max(200),
      })
      .strict(),
  })
  .strict();

export type BroadcastCall = z.infer<typeof BROADCAST_CALL>;

/** What the case answers: ok, and whether the line is new. */
export type BroadcastAnswer = { kind: 'broadcast'; ok: true; was: 'new' | 'already' };

export async function receiveBroadcast(
  ownerId: string,
  a: BroadcastCall['args'],
): Promise<BroadcastAnswer> {
  const line = await announcementLine(ownerId, {
    broadcastId: a.id.toLowerCase(),
    title: a.title.trim() || null,
    body: a.body,
    by: a.by.trim(),
  });
  if (line.was === 'new' && line.seq !== null) {
    const seq = line.seq;
    // After commit, apart from the CC's call: a slow relay never makes the
    // CC send it again, and the line is the record.
    void pushAnnouncement(ownerId, {
      conversationId: line.conversationId,
      seq,
      title: a.title.trim() || null,
      body: a.body,
    }).catch((err) => log('control').warn(`broadcast ${a.id} push: ${errorMessage(err)}`));
  }
  return { kind: 'broadcast', ok: true, was: line.was };
}
