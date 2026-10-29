/**
 * The Moderator seat of a turn, read again at each write. An assistant
 * turn's scope carries the Moderator seats its login held when the turn
 * began (modWs, agent-viewer.ts withAgentScope), and the
 * database's checks read them from the scope for the whole turn. A seat
 * taken away during a long turn would still count there, so the gate's
 * pre-run check (gate-prerun.ts) asks the seats again before each write
 * call: one indexed read of workspace_users, only for a turn that holds a
 * seat. A seat gone refuses the call in MODERATOR_SEAT_CHANGED's words; the
 * next turn reads the seats afresh.
 */
import { moderatorSeatsNow } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';

/** What a write call says when its turn's Moderator seat is gone. */
export const MODERATOR_SEAT_CHANGED =
  'Your Moderator seat in this workspace changed during this turn, so this change was not made. Send your message again.';

/** Whether the current assistant turn holds a Moderator seat its login no
 *  longer holds. False outside an assistant turn and for a turn that holds
 *  none (nothing to read). */
export async function moderatorSeatLost(): Promise<boolean> {
  const scope = currentWorkspaceScope();
  if (!scope || scope.kind !== 'assistant' || !scope.loginId || scope.modWs.length === 0) {
    return false;
  }
  const held = new Set(
    (await moderatorSeatsNow(scope.loginId, scope.modWs)).map((ws) => ws.toLowerCase()),
  );
  return scope.modWs.some((ws) => !held.has(ws.toLowerCase()));
}
