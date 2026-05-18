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
  telegramAccounts,
  telegramChats,
  type TelegramAccount,
} from '@mantle/db';
import { sendMessage } from '@mantle/telegram';
import {
  listDueReminders,
  markReminderSent,
  ownersWithEvents,
  type EventRow,
} from '../lib/events';

const TICK_MS = 30_000;

async function findReminderChat(ownerId: string): Promise<{
  account: TelegramAccount;
  telegramChatId: string;
} | null> {
  const [row] = await db
    .select({
      telegramChatId: telegramChats.telegramChatId,
      account: telegramAccounts,
    })
    .from(telegramChats)
    .innerJoin(telegramAccounts, eq(telegramAccounts.id, telegramChats.accountId))
    .where(
      and(
        eq(telegramChats.userId, ownerId),
        eq(telegramChats.chatType, 'private'),
        eq(telegramChats.allowlistStatus, 'allowed'),
        eq(telegramAccounts.enabled, true),
      ),
    )
    .orderBy(desc(telegramChats.lastMessageAt))
    .limit(1);
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
  if (e.body) lines.push('', e.body);
  return lines.join('\n');
}

async function tick(): Promise<void> {
  const owners = await ownersWithEvents();
  for (const ownerId of owners) {
    const due = await listDueReminders(ownerId, 50);
    if (due.length === 0) continue;
    const target = await findReminderChat(ownerId);
    if (!target) {
      console.warn(
        `[events-reminders] ${due.length} reminders due for owner ${ownerId}, but no allowed Telegram DM. Skipping.`,
      );
      continue;
    }
    for (const evt of due) {
      try {
        await sendMessage(target.account, target.telegramChatId, formatReminder(evt));
        await markReminderSent(evt.id);
        console.log(
          `[events-reminders] sent reminder for "${evt.title}" → chat ${target.telegramChatId}`,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
