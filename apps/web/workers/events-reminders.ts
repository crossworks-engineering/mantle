/**
 * Events reminder worker. Every 30s:
 *
 *   1. For each owner with at least one event, find rows where
 *      remind_at <= now() AND reminder_sent_at IS NULL.
 *   2. Deliver each reminder on the owner's reminder channel (profile pref
 *      `reminderChannel`, which auto-follows the surface they last messaged on —
 *      see noteInboundChannel; defaults to 'telegram'):
 *        - 'telegram' → send via the most-recent allow-listed private DM
 *          (telegram_chats, ordered by last_message_at desc), optionally pinned
 *          to a persona via `reminderAgentSlug`.
 *        - 'mobile'   → record an OUTBOUND assistant turn (channel='mobile')
 *          attributed to the owner's reminder/default agent. That turn lands in
 *          the unified conversation stream (the companion app shows it) AND fires
 *          conversation_changed → push-notify worker → a sealed push to enrolled
 *          devices. The recorded turn IS the delivery; no enrolled device is
 *          required for the reminder to reach the app's thread.
 *   3. Mark reminder_sent_at (or roll a recurrence forward) so we don't re-fire.
 *
 * Idempotent: even if the worker restarts mid-batch, the worst case is a
 * duplicate (we mark sent AFTER the send/record). Single-user system, fine.
 *
 * If the telegram channel has no allowed DM, we LEAVE reminder_sent_at null and
 * log — the next tick retries once the user pairs a chat. See
 * docs/reminder-delivery-routing.md.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  db,
  agents,
  channels,
  telegramAccounts,
  telegramChats,
  type TelegramAccount,
} from '@mantle/db';
import { sendMessage } from '@mantle/telegram';
import { recordTurn } from '@mantle/agent-runtime';
import { loadProfilePreferences, maybeRunScheduledBackups } from '@mantle/content';
import { maybeSweep } from '@mantle/tools';
import { pickWebDefaultAgent } from '@mantle/assistant-runtime';
import {
  listDueReminders,
  markReminderSent,
  rollForwardRecurrence,
  ownersWithEvents,
  type EventRow,
} from '../lib/events';

/** Chat-capable roles a reminder can be attributed to when delivering to the
 *  app (mirrors resolveAssistantAgent's candidate set). */
const CHATTABLE_ROLES = ['assistant', 'responder', 'custom'] as const;

const TICK_MS = 30_000;

type ReminderTarget = { account: TelegramAccount; telegramChatId: string };

/** The owner's allowed private DM, ordered most-recent-first. When
 *  `preferredAgentSlug` is set, restrict to the bot whose channel is attached to
 *  that agent (so reminders come from a chosen persona, e.g. Saskia). Gated on
 *  the channel being enabled (docs/comms-channels.md). */
async function findReminderChat(
  ownerId: string,
  preferredAgentSlug?: string,
): Promise<ReminderTarget | null> {
  const query = (channelAgentId?: string) =>
    db
      .select({
        telegramChatId: telegramChats.telegramChatId,
        account: telegramAccounts,
      })
      .from(telegramChats)
      .innerJoin(telegramAccounts, eq(telegramAccounts.id, telegramChats.accountId))
      .innerJoin(channels, eq(channels.id, telegramAccounts.channelId))
      .where(
        and(
          eq(telegramChats.userId, ownerId),
          eq(telegramChats.chatType, 'private'),
          eq(telegramChats.allowlistStatus, 'allowed'),
          eq(channels.type, 'telegram'),
          eq(channels.enabled, true),
          ...(channelAgentId ? [eq(channels.agentId, channelAgentId)] : []),
        ),
      )
      .orderBy(desc(telegramChats.lastMessageAt))
      .limit(1);

  // Preferred persona: resolve its agent id, then its bot's allowed DM.
  if (preferredAgentSlug) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, preferredAgentSlug)))
      .limit(1);
    if (agent) {
      const [row] = await query(agent.id);
      if (row) return { account: row.account, telegramChatId: row.telegramChatId };
      console.warn(
        `[events-reminders] reminder agent '${preferredAgentSlug}' has no allowed DM; falling back to the most-recent chat.`,
      );
    } else {
      console.warn(
        `[events-reminders] reminder agent '${preferredAgentSlug}' not found; falling back to the most-recent chat.`,
      );
    }
  }

  // Fallback: most-recently-active allowed private chat, any enabled bot.
  const [row] = await query();
  if (!row) return null;
  return { account: row.account, telegramChatId: row.telegramChatId };
}

function formatReminder(e: EventRow): string {
  // Format in the event's IANA timezone so the user sees the wall-clock
  // time they entered, not whatever timezone the worker process runs in.
  // (Without this, a 14:00 event created in CET would render as 13:00
  // when the worker is in UTC — confusing and wrong.)
  let startTime: string;
  try {
    startTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: e.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(e.startsAt));
    if (e.timezone !== 'UTC') startTime += ` (${e.timezone})`;
  } catch {
    // Defensive fallback if e.timezone somehow isn't a valid IANA zone.
    startTime = new Date(e.startsAt).toISOString();
  }
  const lines = [`⏰ Reminder: *${e.title}*`, `Starts: ${startTime}`];
  if (e.location) lines.push(`Where: ${e.location}`);
  if (e.recur !== 'none') lines.push(`🔁 Repeats ${e.recur}`);
  if (e.body) lines.push('', e.body);
  return lines.join('\n');
}

type ReminderAgent = { id: string; slug: string };

/** Which agent a mobile reminder is attributed to: the pinned `reminderAgentSlug`
 *  persona when set + enabled, else the owner's web-default agent. Returns null
 *  when the owner has no enabled chat-capable agent at all (can't record a turn
 *  without one). Mirrors resolveAssistantAgent (assistant.ts) but kept local +
 *  lightweight so the worker doesn't pull the whole responder graph. */
async function resolveReminderAgent(
  ownerId: string,
  preferredSlug?: string,
): Promise<ReminderAgent | null> {
  if (preferredSlug) {
    const [picked] = await db
      .select({ id: agents.id, slug: agents.slug })
      .from(agents)
      .where(
        and(eq(agents.ownerId, ownerId), eq(agents.slug, preferredSlug), eq(agents.enabled, true)),
      )
      .limit(1);
    if (picked) return picked;
    console.warn(
      `[events-reminders] reminder agent '${preferredSlug}' not found/enabled; using the web-default agent.`,
    );
  }
  const candidates = await db
    .select({ id: agents.id, slug: agents.slug, role: agents.role, priority: agents.priority })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, [...CHATTABLE_ROLES]),
      ),
    );
  const pick = pickWebDefaultAgent(candidates);
  return pick ? { id: pick.id, slug: pick.slug } : null;
}

/** Recurring events roll their single row forward to the next occurrence
 *  (re-arming the reminder); one-shots just get marked sent. Call AFTER a
 *  successful delivery so a failed send retries next tick. */
async function markReminderDone(evt: EventRow): Promise<void> {
  if (evt.recur !== 'none') {
    await rollForwardRecurrence(evt.id);
  } else {
    await markReminderSent(evt.id);
  }
}

async function tick(): Promise<void> {
  // Piggyback the periodic tick to sweep expired tool-result spills. Shares an
  // hourly throttle with the opportunistic spill-path sweep, so this runs even
  // when nothing's spilling; fire-and-forget, never throws.
  maybeSweep();
  // Scheduled local DB backups (/settings/backups) — same piggyback pattern:
  // internally throttled to one due-check per minute, never throws.
  void maybeRunScheduledBackups();
  const owners = await ownersWithEvents();
  for (const ownerId of owners) {
    const due = await listDueReminders(ownerId, 50);
    if (due.length === 0) continue;
    const prefs = await loadProfilePreferences(ownerId);

    // 'mobile' → deliver to the companion app by recording an outbound turn;
    // anything else (incl. the default/unset) → Telegram. reminderChannel
    // auto-follows the last surface the user messaged on (noteInboundChannel).
    if (prefs.reminderChannel === 'mobile') {
      const agent = await resolveReminderAgent(ownerId, prefs.reminderAgentSlug);
      if (!agent) {
        console.warn(
          `[events-reminders] ${due.length} reminders due for owner ${ownerId} (mobile), but no enabled chat agent to attribute them to. Skipping.`,
        );
        continue;
      }
      for (const evt of due) {
        try {
          // The recorded turn IS the delivery: it lands in the unified stream
          // (the app shows it) and fires conversation_changed → push-notify →
          // a sealed push to enrolled devices. No device required for it to
          // reach the thread, so we mark done unconditionally on success.
          await recordTurn({
            ownerId,
            agentId: agent.id,
            direction: 'outbound',
            text: formatReminder(evt),
            channel: 'mobile',
          });
          await markReminderDone(evt);
          console.log(
            `[events-reminders] recorded mobile reminder for "${evt.title}"` +
              (evt.recur !== 'none' ? ` (repeats ${evt.recur}, rolled forward)` : '') +
              ` → agent ${agent.slug}`,
          );
        } catch (err) {
          console.error(`[events-reminders] failed mobile reminder for ${evt.id}:`, err);
          // Leave reminder_sent_at null so we retry next tick.
        }
      }
      continue;
    }

    const target = await findReminderChat(ownerId, prefs.reminderAgentSlug);
    if (!target) {
      console.warn(
        `[events-reminders] ${due.length} reminders due for owner ${ownerId}, but no allowed Telegram DM. Skipping.`,
      );
      continue;
    }
    for (const evt of due) {
      try {
        await sendMessage(target.account, target.telegramChatId, formatReminder(evt));
        await markReminderDone(evt);
        console.log(
          `[events-reminders] sent reminder for "${evt.title}"` +
            (evt.recur !== 'none' ? ` (repeats ${evt.recur}, rolled forward)` : '') +
            ` → chat ${target.telegramChatId}`,
        );
      } catch (err) {
        console.error(`[events-reminders] failed to send reminder for ${evt.id}:`, err);
        // Leave reminder_sent_at null so we retry next tick.
      }
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('[events-reminders] DATABASE_URL must be set');
    process.exit(1);
  }
  console.log(`[events-reminders] up. Polling every ${TICK_MS / 1000}s.`);
  let running = false;
  // Shared runner so the immediate boot-time tick goes through the
  // same single-flight guard as scheduled ones. Previously the initial
  // `tick()` was fire-and-forget — if it took longer than TICK_MS
  // (slow Telegram send, retried-network), the first scheduled tick
  // could overlap with it.
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error('[events-reminders] tick error:', err);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(runOnce, TICK_MS);
  // Fire one tick immediately so a freshly-created event doesn't have
  // to wait 30s when it's already overdue.
  void runOnce();

  const shutdown = () => {
    console.log('[events-reminders] shutting down…');
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Backstop: tick() runs inside runOnce's try/catch (single-flight guarded),
// but a rejection that slips past should log and keep the worker alive rather
// than crash-loop on a transient PostgresError. Docker would bounce us anyway;
// staying up is strictly better.
process.on('unhandledRejection', (reason) => {
  console.error('[events-reminders] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
