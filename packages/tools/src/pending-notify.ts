/**
 * Approval-presentation fan-out. When a tool call is queued for the
 * operator's decision (or a queued call is decided), this module makes
 * the change *visible* wherever the operator might be looking:
 *
 *   - in-app  → pg_notify('pending_changed', ownerId). The web app's
 *               realtime bridge (server/web/lib/realtime.ts) LISTENs and
 *               repaints the sidebar badge + /pending live, no refresh.
 *               The push-notify worker also LISTENs and (for `mobile`
 *               operators) sends a device push deep-linking to /pending.
 *   - Telegram → (since workspaces W7d: only to a chat paired to the call's
 *               own login, the anchor's for system calls and for a call
 *               its asker may not approve (elevated), and only while that
 *               login holds the settings area)
 *               a one-tap Approve/Reject card pushed to the operator's
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
import {
  asSystem,
  db,
  executeWrite,
  loginHasArea,
  pendingToolCalls,
  telegramChats,
} from '@mantle/db';
import { accountById, sendApprovalCard } from '@mantle/telegram';
import { loadProfilePreferences } from '@mantle/content';
import { registerPendingCreatedNotifier } from '@mantle/runs';

/**
 * This file's one system door (arch A6): the chat a pending call's notice goes
 * to, and its login, are read on the system pool by the named reason
 * 'login-telegram'. Every read below goes through it.
 */
function telegramLoginSystem<T>(fn: () => Promise<T>): Promise<T> {
  return asSystem(fn, 'login-telegram');
}

/** The Postgres channel the web realtime bridge LISTENs on for approval
 *  queue changes. Exported so notifier + listener share one string. */
export const PENDING_CHANGED_CHANNEL = 'pending_changed';

/**
 * Wake any connected browser to repaint its pending-approval count.
 * Call after a row is queued, approved, or rejected. Soft-fails.
 */
export async function notifyPendingChanged(ownerId: string): Promise<void> {
  try {
    await executeWrite(sql`SELECT pg_notify(${PENDING_CHANGED_CHANNEL}, ${ownerId})`);
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
 * Who decides a queued call, for its card (workspaces W7d): the login it
 * was queued for (pending_tool_calls.login_id), else the anchor (a call of
 * system work, or the anchor's own). An elevated call goes to the anchor
 * (A5 step 6d fix round 1): its asker may not approve it
 * (pending-approval.ts). Null when the call is gone.
 */
async function approvalLogin(ownerId: string, pendingId: string): Promise<string | null> {
  const [row] = await db
    .select({ loginId: pendingToolCalls.loginId, elevated: pendingToolCalls.elevated })
    .from(pendingToolCalls)
    .where(and(eq(pendingToolCalls.id, pendingId), eq(pendingToolCalls.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  if (row.elevated) return ownerId;
  return row.loginId ?? ownerId;
}

/**
 * The paired Telegram chat to send an approval card to (workspaces W7d): an
 * `allowed` chat paired to `loginId` (the call's own login), most recently
 * active first, and only while that login may decide approvals (the
 * settings area, the rule of /api/pending and of a card's tap). Null when
 * it has none or may not decide: the in-app surface still has the call.
 */
export async function resolveApprovalChat(
  ownerId: string,
  loginId: string,
): Promise<{ accountId: string; telegramChatId: string } | null> {
  if (!(await loginHasArea(loginId, 'settings'))) return null;
  const [chat] = await telegramLoginSystem(() =>
    db
      .select({
        accountId: telegramChats.accountId,
        telegramChatId: telegramChats.telegramChatId,
      })
      .from(telegramChats)
      .where(
        and(
          eq(telegramChats.userId, ownerId),
          eq(telegramChats.loginId, loginId),
          eq(telegramChats.allowlistStatus, 'allowed'),
        ),
      )
      .orderBy(desc(telegramChats.lastMessageAt))
      .limit(1),
  );
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
  /** The call needs an Admin user's approval, its asker's rights not
   *  reaching it (pending_tool_calls.elevated, owner decision 1a, A5 step
   *  6d): its card goes to the owner, never to its asker. */
  elevated?: { elevated: true; reason: string };
  /** The turn that queued it read text a client wrote (0287): the card
   *  says so. */
  clientSourced?: { via: string };
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
    // The card goes to the call's own login only (W7d): its chat, its last
    // channel.
    const loginId = await telegramLoginSystem(() => approvalLogin(input.ownerId, input.pendingId));
    if (!loginId) return;
    const prefs = await loadProfilePreferences(loginId);
    if (prefs.reminderChannel === 'mobile') return;

    const chat = await resolveApprovalChat(input.ownerId, loginId);
    if (!chat) return;
    const account = await accountById(chat.accountId);
    if (!account) return;
    // A runner question is delivered as a heads-up, never as an approval
    // card: Telegram can only say yes/no, and a yes would be recorded as the
    // operator's ANSWER. `previewArgs` also can't show a questionnaire (it
    // renders `form={…}`), so the sub-questions would be invisible anyway.
    const question =
      input.toolSlug === 'ask_human'
        ? ((input.args?.['question'] as string | undefined)?.trim() ??
          'A run is waiting on a decision.')
        : undefined;
    await sendApprovalCard(account, chat.telegramChatId, {
      pendingId: input.pendingId,
      toolSlug: input.toolSlug,
      argsPreview: previewArgs(input.args),
      via: input.via,
      ...(input.elevated ? { elevated: input.elevated.reason } : {}),
      ...(input.clientSourced ? { clientSourced: input.clientSourced.via } : {}),
      ...(question ? { question } : {}),
    });
  } catch (err) {
    console.error(
      '[pending:notify] Telegram approval push failed (in-app /pending still has it):',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Wire the runner engine's approval rows into this fan-out. The engine
 * creates `ask_human` questions and `run_budget` pauses inside its own
 * transaction and cannot call us directly (it would close an import cycle —
 * this package already imports @mantle/runs), so it emits a
 * `pending_created` post-commit action and @mantle/runs calls whatever is
 * registered here. Registering at module load means any process that touches
 * @mantle/tools announces its questions; without it a parked run is silent.
 */
registerPendingCreatedNotifier(notifyPendingCreated);
