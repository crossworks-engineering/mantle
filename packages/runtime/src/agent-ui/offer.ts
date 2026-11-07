/**
 * Whether a turn is offered the agent UI tools (docs/agent-ui.md), a leaf:
 * the turn must name its window, stream (the ui-call event rides the turn's
 * stream; no stream, no window to reach), serve a signed-in login, and that
 * login's setting must be on (read by the brain when the turn starts, never
 * taken from the client). The same rule on both engines: an owner turn
 * (run-turn.ts) and a member's workspace turn (run-team-turn.ts).
 */
import { isAgentUiWindowId } from '@mantle/client-types/agent-ui';
import { uiWindowSeats, type UiWindowSeats } from './seat';

/** The window the turn's ui tools act in, or undefined: no ui tools. */
export function agentUiWindowFor(t: {
  windowId?: string | null;
  streamId?: string | null;
  loginId?: string | null;
  enabled: boolean;
}): string | undefined {
  if (!t.enabled || !t.streamId || !t.loginId) return undefined;
  return isAgentUiWindowId(t.windowId) ? t.windowId : undefined;
}

/**
 * The window a turn may drive now: its journaled decision (agentUiWindowFor,
 * read when the turn started) and its login's seat (seat.ts), taken here on
 * every run of the turn. While another turn of the login drives a window,
 * this one runs with none, so it is offered no ui tools.
 */
export function seatedUiWindow(
  decided: string | null,
  t: { loginId?: string | null; streamId?: string | null },
  seats: Pick<UiWindowSeats, 'take'> = uiWindowSeats,
): string | null {
  if (!decided || !t.loginId || !t.streamId) return null;
  return seats.take(t.loginId, t.streamId) ? decided : null;
}
