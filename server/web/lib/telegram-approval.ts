/**
 * The approval-card button handler the Telegram poller runs (moved out of
 * workers/telegram-poll.ts so it can be tested: the worker starts its loop
 * when imported). Injected into the poller so the telegram package can apply
 * decisions without importing @mantle/tools (which would close a dependency
 * cycle).
 *
 * A tap decides as the login the tapped chat is paired to
 * (resolved by the poller from the chat row, never from the callback), by
 * the rule of /api/pending: only a login holding the settings area decides,
 * and it decides only the calls queued for it (pending_tool_calls.login_id;
 * the anchor: every call).
 */
import { loginHasArea } from '@mantle/db';
import type { PollHandlers } from '@mantle/telegram';
import { approvePendingCall, getPendingCall, rejectPendingCall } from '@mantle/tools';

export const telegramApprovalHandlers: PollHandlers = {
  onApproval: async ({ ownerId, loginId, decision, pendingId }) => {
    try {
      if (!(await loginHasArea(loginId, 'settings'))) {
        return { ok: false, text: 'You cannot decide approvals: ask an Admin user to.' };
      }
      // Telegram announces runner questions; it never answers them. Current
      // question notices ship with no buttons at all, so this only catches a
      // card sent by an older build that is still sitting in a chat, but
      // tapping it must not record a yes/no as the operator's answer to a
      // question that asked something else entirely.
      const existing = await getPendingCall(ownerId, pendingId);
      if (existing?.toolSlug === 'ask_human') {
        return {
          ok: false,
          text: 'This is a question, not a yes/no approval: answer it in Mantle (Pending approvals).',
        };
      }
      const row =
        decision === 'approve'
          ? await approvePendingCall(ownerId, pendingId, { approverLoginId: loginId })
          : await rejectPendingCall(ownerId, pendingId, loginId);
      if (!row) return { ok: false, text: 'Already decided, or no longer pending.' };
      if (decision === 'reject') return { ok: true, text: `Rejected ${row.toolSlug}.` };
      if (row.error) {
        return {
          ok: true,
          text: `Approved ${row.toolSlug}, it ran but failed: ${row.error.slice(0, 120)}`,
        };
      }
      return { ok: true, text: `Approved & ran ${row.toolSlug}.` };
    } catch (err) {
      // A refusal of the approval rule (pending-approval.ts: the asker of an
      // elevated call, or an approver without write rights on its
      // connector) reads whole; Telegram shows up to 200 characters.
      return {
        ok: false,
        text: err instanceof Error ? err.message.slice(0, 200) : 'Failed to apply.',
      };
    }
  },
};
