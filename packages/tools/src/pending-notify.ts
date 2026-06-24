/**
 * Approval-presentation fan-out. When a tool call is queued for the
 * operator's decision (or a queued call is decided), this module makes
 * the change *visible* wherever the operator might be looking:
 *
 *   - in-app  → pg_notify('pending_changed', ownerId). The web app's
 *               realtime bridge (apps/web/lib/realtime.ts) LISTENs and
 *               repaints the sidebar badge + /pending live, no refresh.
 *               The push-notify worker also LISTENs and (for `mobile`
 *               operators) sends a device push deep-linking to /pending.
 *   - Telegram → a one-tap Approve/Reject card pushed to the operator's
 *               paired chat, so an approval can be acted on from a phone
 *               while away from the app.
 *
 * The active approval surface follows `reminderChannel` — the sticky
 * last-communication-channel signal (see docs/reminder-delivery-routing.md):
 * a `mobile` operator gets the in-app queue + a device push (and NO Telegram
 * card); a `telegram`/unset operator gets the Telegram card. Routing to one
 * channel avoids double-notifying. The in-app badge fires regardless.
 *
 * Everything here is fire-and-forget: a notify or push failure must never
 * break the turn that queued the call — the row is already persisted and
 * the /pending page is the source of truth regardless.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, telegramChats } from '@mantle/db';
import { accountById, sendApprovalCard } from '@mantle/telegram';
import { loadProfilePreferences } from '@mantle/content';

/** The Postgres channel the web realtime bridge LISTENs on for approval
 *  queue changes. Exported so notifier + listener share one string. */
export const PENDING_CHANGED_CHANNEL = 'pending_changed';

/**
 * Wake any connected browser to repaint its pending-approval count.
 * Call after a row is queued, approved, or rejected. Soft-fails.
 */
export async function notifyPendingChanged(ownerId: string): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify(${PENDING_CHANGED_CHANNEL}, ${ownerId})`);
  } catch (err) {
    console.error(
      '[pending:notify] pg_notify failed (badge will catch up on next load):',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Build a short, secret-free args preview for the Telegram card. Keys
 *  that look sensitive are redacted; values are truncated; the whole line
 *  is capped. The /pending page shows the full payload — this is only the
 *  at-a-glance phone view. */
function previewArgs(args: Record<string, unknown>): string | undefined {
  const keys = Object.keys(args ?? {});
  if (keys.length === 0) return undefined;
  const SENSITIVE = /secret|token|password|passwd|api[-_]?key|auth|bearer|credential/i;
  const parts: string[] = [];
  for (const k of keys.slice(0, 4)) {
    if (SENSITIVE.test(k)) {
      parts.push(`${k}=•••`);
      continue;
    }
    const v = args[k];
    let shown: string;
    if (v == null) shown = String(v);
    else if (typeof v === 'object') shown = Array.isArray(v) ? `[${v.length}]` : '{…}';
    else shown = String(v);
    if (shown.length > 60) shown = shown.slice(0, 57) + '…';
    parts.push(`${k}=${shown}`);
  }
  if (keys.length > 4) parts.push(`+${keys.length - 4} more`);
  const line = parts.join('\n');
  return line.length > 600 ? line.slice(0, 597) + '…' : line;
}

/**
 * The most appropriate paired Telegram chat to send an approval card to:
 * an `allowed` chat owned by this operator, most-recently-active first.
 * Returns null if the operator has no paired chat (then we just rely on
 * the in-app surface).
 */
async function resolveApprovalChat(
  ownerId: string,
): Promise<{ accountId: string; telegramChatId: string } | null> {
  const [chat] = await db
    .select({
      accountId: telegramChats.accountId,
      telegramChatId: telegramChats.telegramChatId,
    })
    .from(telegramChats)
    .where(
      and(
        eq(telegramChats.userId, ownerId),
        eq(telegramChats.allowlistStatus, 'allowed'),
      ),
    )
    .orderBy(desc(telegramChats.lastMessageAt))
    .limit(1);
  return chat ?? null;
}

/**
 * Fan out a newly-queued approval: bump the in-app badge AND push a
 * one-tap card to the operator's paired Telegram chat (if any). Both
 * arms soft-fail independently.
 */
export async function notifyPendingCreated(input: {
  ownerId: string;
  pendingId: string;
  toolSlug: string;
  args: Record<string, unknown>;
  via?: string;
}): Promise<void> {
  // In-app badge first — cheapest, always relevant. (This also wakes the
  // push-notify worker, which sends a device push when the operator's
  // channel is `mobile`.)
  await notifyPendingChanged(input.ownerId);

  // The Telegram card is the approval surface only when the operator's last
  // channel is Telegram (or unset). A `mobile` operator approves from the
  // companion app's /pending queue (woken by the push above), so skip the
  // card to avoid notifying on two channels.
  try {
    const prefs = await loadProfilePreferences(input.ownerId);
    if (prefs.reminderChannel === 'mobile') return;

    const chat = await resolveApprovalChat(input.ownerId);
    if (!chat) return;
    const account = await accountById(chat.accountId);
    if (!account) return;
    await sendApprovalCard(account, chat.telegramChatId, {
      pendingId: input.pendingId,
      toolSlug: input.toolSlug,
      argsPreview: previewArgs(input.args),
      via: input.via,
    });
  } catch (err) {
    console.error(
      '[pending:notify] Telegram approval push failed (in-app /pending still has it):',
      err instanceof Error ? err.message : err,
    );
  }
}
