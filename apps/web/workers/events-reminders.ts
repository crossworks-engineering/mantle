/**
 * Events reminder worker. Every 30s:
 *
 *   1. For each owner with at least one event, find rows where
 *      remind_at <= now() AND reminder_sent_at IS NULL.
 *   2. Resolve the owner's reminder target = the most-recent DM
 *      that's been allow-listed (telegram_chats.allowlist_status='allowed',
 *      chat_type='private', ordered by last_message_at desc).
 *   3. Send a Telegram message via the account that owns that chat.
 *   4. Mark reminder_sent_at so we don't re-fire on the next tick.
 *
 * Idempotent: even if the worker restarts mid-batch, the worst case is
 * a duplicate send (we mark sent AFTER the Telegram API call). Single-
 * user system, fine.
 *
 * If no allowed DM exists for the owner, we LEAVE reminder_sent_at null
 * and log — the next tick will retry once the user pairs a chat.
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  db,
  agents,
  channels,
  telegramAccounts,
  telegramChats,
  type TelegramAccount,
} from '@mantle/db';
import { sendMessage } from '@mantle/telegram';
import { loadProfilePreferences, maybeRunScheduledBackups } from '@mantle/content';
import { maybeSweep } from '@mantle/tools';
import {
  listDueReminders,
  markReminderSent,
  rollForwardRecurrence,
  ownersWithEvents,
  type EventRow,
} from '../lib/events';

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
        // Recurring events roll their single row forward to the next
        // occurrence (re-arming the reminder); one-shots just get marked
        // sent. rollForwardRecurrence handles both, so call it always.
        if (evt.recur !== 'none') {
          await rollForwardRecurrence(evt.id);
        } else {
          await markReminderSent(evt.id);
        }
        console.log(
          `[events-reminders] sent reminder for "${evt.title}"` +
            (evt.recur !== 'none' ? ` (repeats ${evt.recur}, rolled forward)` : '') +
            ` → chat ${target.telegramChatId}`,
        );
      } catch (err) {
        console.error(
          `[events-reminders] failed to send reminder for ${evt.id}:`,
          err,
        );
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
