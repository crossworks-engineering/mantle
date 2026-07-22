/**
 * One-way bridge that lets the engine announce a newly-created approval row
 * without importing `@mantle/tools` — which it cannot: tools already imports
 * runs (`applyHumanAnswer`, `RUN_BUDGET_TOOL_SLUG`), so the reverse edge would
 * be a cycle. Same idiom as `registerAgentInvoker` in @mantle/tools.
 *
 *   // packages/tools/src/index.ts (module load)
 *   import { registerPendingCreatedNotifier } from '@mantle/runs';
 *   registerPendingCreatedNotifier(notifyPendingCreated);
 *
 * WHY: an `ask_human` gate (and a `run_budget` pause) inserts its
 * `pending_tool_calls` row inside the engine transaction, and until this
 * bridge existed nothing fired the approval fan-out — so a parked run was
 * SILENT: no live badge repaint, no companion push, no Telegram card. The
 * operator only found a blocked run by visiting /pending.
 *
 * The notification is ADVISORY. Losing it loses a ping, never correctness:
 * the row is the truth and every surface catches up on its next load. So the
 * `pending_created` action gets no sweep re-send machinery, and a failing
 * notifier is logged and swallowed by the caller.
 */

/** What the fan-out needs to present a queued approval. Mirrors the input of
 *  `notifyPendingCreated` in @mantle/tools (the only implementation). */
export type PendingCreatedNotice = {
  ownerId: string;
  pendingId: string;
  toolSlug: string;
  args: Record<string, unknown>;
};

export type PendingCreatedNotifier = (notice: PendingCreatedNotice) => Promise<void>;

let registered: PendingCreatedNotifier | null = null;
let warned = false;

/** Register the fan-out implementation. Called at module load by
 *  @mantle/tools; idempotent, last write wins. */
export function registerPendingCreatedNotifier(fn: PendingCreatedNotifier): void {
  registered = fn;
}

/**
 * Fire the fan-out for a queued approval. Soft-fails in every direction — an
 * unregistered notifier warns ONCE (a process that creates questions but
 * can't announce them is a wiring bug worth seeing, but not worth a log line
 * per question), and a throwing notifier is logged and swallowed.
 */
export async function notifyPendingCreated(notice: PendingCreatedNotice): Promise<void> {
  if (!registered) {
    if (!warned) {
      warned = true;
      console.warn(
        '[runs] no pending-created notifier registered in this process — approval rows ' +
          'are created but not announced (import @mantle/tools at boot to wire it).',
      );
    }
    return;
  }
  try {
    await registered(notice);
  } catch (err) {
    console.error(
      '[runs] pending-created notify failed (the row still stands; surfaces catch up on load):',
      err instanceof Error ? err.message : err,
    );
  }
}
