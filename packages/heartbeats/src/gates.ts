/**
 * Gate checks — "is now an appropriate time for this heartbeat?"
 *
 * Per-heartbeat-only policy: each gate is opt-in via a non-null
 * column on the heartbeat row. NULL columns mean "no check of that
 * kind". There are no system-wide defaults — the heartbeat author
 * is responsible for being explicit about what counts as polite.
 *
 * Returns either { ok: true } or { ok: false, reason: '...' } where
 * reason maps to a HeartbeatFireDisposition like 'skipped_quiet'.
 * The fire orchestrator translates that into both a heartbeat_fires
 * audit row and (via next_fire_at) a polite reschedule.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, telegramMessages, telegramChats, type Heartbeat } from '@mantle/db';
import { loadProfilePreferences } from '@mantle/content';

export type GateResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'skipped_idle' | 'skipped_quiet' | 'skipped_cooldown' | 'skipped_earliest';
      detail?: string;
    };

export async function checkGates(hb: Heartbeat, now: Date = new Date()): Promise<GateResult> {
  // 1. earliest_at — hard floor. Cheapest check; do first.
  if (hb.earliestAt && now < hb.earliestAt) {
    return {
      ok: false,
      reason: 'skipped_earliest',
      detail: `earliest_at=${hb.earliestAt.toISOString()}`,
    };
  }

  // 2. cooldown — was THIS heartbeat fired too recently?
  if (hb.cooldownMinutes != null && hb.lastFiredAt) {
    const elapsedMs = now.getTime() - hb.lastFiredAt.getTime();
    const minMs = hb.cooldownMinutes * 60_000;
    if (elapsedMs < minMs) {
      const remainingMin = Math.ceil((minMs - elapsedMs) / 60_000);
      return { ok: false, reason: 'skipped_cooldown', detail: `${remainingMin}min remaining` };
    }
  }

  // 3. quiet_hours — is "now in surface tz" inside the do-not-disturb window?
  if (hb.quietHours) {
    const tz = hb.quietHours.tz ?? (await loadProfilePreferences(hb.ownerId)).timezone;
    if (isInsideWindow(now, hb.quietHours.from, hb.quietHours.to, tz)) {
      return {
        ok: false,
        reason: 'skipped_quiet',
        detail: `inside ${hb.quietHours.from}–${hb.quietHours.to} ${tz}`,
      };
    }
  }

  // 4. idle — has the user been quiet on this surface for long enough?
  //    Only applies to surfaces that have an inbound concept; web for
  //    now has none, so the check is telegram-only.
  if (hb.minIdleMinutes != null) {
    const idleOk = await checkIdle(hb, now);
    if (!idleOk.ok) return idleOk;
  }

  return { ok: true };
}

/** Time-of-day window check honouring the surface's timezone. Handles
 *  windows that cross midnight (22:00–07:00). Exported for testing —
 *  the DB-dependent checkGates wraps it but the time-of-day arithmetic
 *  is the part most likely to have a corner-case bug. */
export function isInsideWindow(now: Date, from: string, to: string, tz: string): boolean {
  // Format the instant as HH:MM in tz, then compare lexicographically —
  // 'HH:MM' format sorts identically to numeric time-of-day.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const nowHM = `${hh}:${mm}`;

  if (from <= to) {
    // Same-day window, e.g. 13:00–17:00.
    return nowHM >= from && nowHM < to;
  }
  // Crosses midnight, e.g. 22:00–07:00. Inside if after `from` OR before `to`.
  return nowHM >= from || nowHM < to;
}

async function checkIdle(hb: Heartbeat, now: Date): Promise<GateResult> {
  const surface = hb.surface;
  if (surface.kind !== 'telegram') {
    // Web / other surfaces don't have a meaningful "last inbound" today.
    // Silently treat as no-idle-check rather than blocking — operator
    // can use cooldown_minutes if they want time gating without inbound.
    return { ok: true };
  }
  // Find the chat row by its Telegram numeric id (stored as text),
  // then check the most recent inbound message timestamp. The FK on
  // telegram_messages.chatId points at telegram_chats.id.
  const [chat] = await db
    .select({ pk: telegramChats.id })
    .from(telegramChats)
    .where(
      and(eq(telegramChats.userId, hb.ownerId), eq(telegramChats.telegramChatId, surface.chat_id)),
    )
    .limit(1);
  if (!chat) return { ok: true }; // no chat row = no recent activity to gate on

  const [lastInbound] = await db
    .select({ at: telegramMessages.createdAt })
    .from(telegramMessages)
    .where(and(eq(telegramMessages.chatId, chat.pk), eq(telegramMessages.direction, 'inbound')))
    .orderBy(desc(telegramMessages.createdAt))
    .limit(1);

  if (!lastInbound) return { ok: true };

  const idleMs = now.getTime() - new Date(lastInbound.at).getTime();
  const requiredMs = (hb.minIdleMinutes ?? 0) * 60_000;
  if (idleMs < requiredMs) {
    const wait = Math.ceil((requiredMs - idleMs) / 60_000);
    return { ok: false, reason: 'skipped_idle', detail: `${wait}min until idle threshold` };
  }
  return { ok: true };
}
