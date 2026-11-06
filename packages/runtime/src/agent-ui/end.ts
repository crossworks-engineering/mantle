/**
 * A turn's end for the agent UI channel (docs/agent-ui.md): its calls'
 * results, the window's view of the person's window, are private output and
 * kept only while the turn runs (a DBOS re-run of a ui step reads them
 * back). Both engines call this once their turn is over, on every path (done,
 * a failure, Stop, a supersede, a used ui budget): the turn runners'
 * outermost `finally` (run-turn.ts, run-team-turn.ts).
 */
import { clearTurnUiCalls } from '@mantle/db';
import { log } from '@mantle/tracing';

/** What the end needs, injectable for tests. */
export type UiTurnEndDeps = { clear: typeof clearTurnUiCalls };

const defaultDeps: UiTurnEndDeps = { clear: (p) => clearTurnUiCalls(p) };

/** Clear the turn's ui calls, when the turn could have made any (it named a
 *  window, streamed and served a login). Never throws: a failed clear is
 *  logged, and the nightly `ui-calls-reap` sweep takes the rows. */
export async function endTurnUiCalls(
  t: { windowId?: string | null; streamId?: string | null; loginId?: string | null },
  deps: UiTurnEndDeps = defaultDeps,
): Promise<void> {
  if (!t.windowId || !t.streamId || !t.loginId) return;
  await deps
    .clear({ turnId: t.streamId, loginId: t.loginId })
    .catch((e: unknown) => log('agent-ui').error("could not clear the turn's ui calls:", e));
}
