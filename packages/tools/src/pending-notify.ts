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
 *   - Telegram → (only to a chat paired to the call's
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

import { sql } from 'drizzle-orm';
import { db, executeWrite } from '@mantle/db';
import { accountById, sendApprovalCard } from '@mantle/telegram';
import { appUrl, loadProfilePreferences } from '@mantle/content';
import { registerPendingCreatedNotifier } from '@mantle/runs';
import { tableBuiltin } from './tool-policy';

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

/** What a card does not show as it is: control and format characters, line and
 *  paragraph separators, and default-ignorable characters (variation selectors,
 *  blank letters). Each shows as the replacement character, and a card with one
 *  carries no Approve. An emoji with a selector loses the tap too: the accepted
 *  cost. */
const UNSHOWABLE = /[\p{C}\p{Zl}\p{Zp}\p{DI}]/gu;

/** The longest preview a card shows, well under Telegram's 4096 for the whole
 *  message: the card's other lines are short. */
const PREVIEW_CAP = 600;

/** The input fields the builtin `slug` marks sensitive, or none (an
 *  authored tool, or the table not loaded yet). */
function redactFieldsOf(slug: string): readonly string[] {
  try {
    return tableBuiltin(slug)?.redactInputFields ?? [];
  } catch {
    return [];
  }
}

/** Build a secret-free args preview for the Telegram card. Keys that look
 *  sensitive are redacted; the whole preview is capped. The /pending page shows
 *  the full payload. `whole` says whether the preview showed every value as it
 *  is: the one check that decides if the card may carry Approve. */
function previewArgs(
  args: Record<string, unknown>,
  toolSlug: string,
): { text?: string; whole: boolean } {
  const keys = Object.keys(args ?? {});
  if (keys.length === 0) return { whole: true };
  const SENSITIVE = /secret|token|password|passwd|api[-_]?key|auth|bearer|credential/i;
  // And the fields the tool itself marks sensitive (redactInputFields: a
  // key's `value`, for example), whatever their name.
  const redact = new Set(redactFieldsOf(toolSlug));
  const parts: string[] = [];
  let whole = keys.length <= 4;
  for (const k of keys.slice(0, 4)) {
    if (SENSITIVE.test(k) || redact.has(k)) {
      whole = false;
      parts.push(`${k}=•••`);
      continue;
    }
    const v = args[k];
    let shown: string;
    if (v == null) shown = String(v);
    else if (typeof v === 'object') {
      whole = false;
      shown = Array.isArray(v) ? `[${v.length}]` : '{…}';
    } else shown = String(v);
    parts.push(`${k}=${shown}`);
  }
  // The keys past the fourth, by name.
  if (keys.length > 4) parts.push(`+${keys.length - 4} more: ${keys.slice(4).join(', ')}`);
  const shownParts = parts.map((p) => p.replace(UNSHOWABLE, '\uFFFD'));
  if (shownParts.some((p, i) => p !== parts[i])) whole = false;
  const line = shownParts.join('\n');
  if (line.length > PREVIEW_CAP) {
    // Cut by whole code point: half an emoji is text Telegram refuses.
    const cut = line.slice(0, PREVIEW_CAP - 3).replace(/[\uD800-\uDBFF]$/, '');
    return { text: `${cut}…`, whole: false };
  }
  return { text: line, whole };
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
   *  reaching it (pending_tool_calls.elevated): its card goes to the owner,
   *  never to its asker. */
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
    // The card goes to the login that decides the call (an elevated call's
    // to the anchor): its chat, its last channel. Both by their definer
    // (mantle_pending_card_route, 0293: in a scope only a call the scope's
    // own login asked). The bot's row (accountById) is read in the caller's
    // scope.
    const [route] = (await db.execute(
      sql`select login_id::text as "loginId", account_id::text as "accountId",
                 telegram_chat_id as "telegramChatId"
            from "public"."mantle_pending_card_route"(${input.ownerId}::uuid, ${input.pendingId}::uuid)`,
    )) as unknown as { loginId: string; accountId: string | null; telegramChatId: string | null }[];
    if (!route) return;
    const prefs = await loadProfilePreferences(route.loginId);
    if (prefs.reminderChannel === 'mobile') return;

    if (!route.accountId || !route.telegramChatId) return;
    const chat = { accountId: route.accountId, telegramChatId: route.telegramChatId };
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
    const preview = previewArgs(input.args, input.toolSlug);
    await sendApprovalCard(account, chat.telegramChatId, {
      pendingId: input.pendingId,
      toolSlug: input.toolSlug,
      argsPreview: preview.text,
      previewWhole: preview.whole,
      pendingUrl: appUrl('/pending'),
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
