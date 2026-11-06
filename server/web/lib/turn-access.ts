/**
 * Whose live turn a turn id is (docs/agent-ui.md, "Members"): the one rule
 * the turn's stream, its Stop and the window's ui answer ask before
 * anything else (app/api/assistant/turn/[turnId]/...).
 *
 * A member's turn (a login that is not an Admin user, on the workspace
 * engine) streams on its workflow id, `ws-<loginId>.<key>`, which POST
 * /api/assistant/turn mints from the session's login (lib/workspace-turn.ts),
 * never from a field the client sends. So the id itself says whose turn it
 * is and nothing is stored for it: such an id is open to that login only,
 * whatever its role, an Admin user's included. Every other id (an Admin
 * user's turn, streamed on its Idempotency-Key) is open to an Admin user, as
 * before; a member gets the same 404 as for a turn that does not exist.
 *
 * An Idempotency-Key shaped like a member's turn id never names a stream
 * (streamableKey): an Admin user cannot publish onto a member's stream.
 */
import type { ChatCaller } from './auth';
import { chatAdmin } from './assistant-chat';

/** What every member turn id starts with. */
export const MEMBER_TURN_PREFIX = 'ws-';

const MEMBER_TURN_RE =
  /^ws-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[^\s/]+$/i;

/** The workflow id, and the stream id, of a member's workspace turn. */
export function memberTurnId(loginId: string, key: string): string {
  return `${MEMBER_TURN_PREFIX}${loginId}.${key}`;
}

/** The login a member turn id names (lower case), or null: not one. */
export function memberTurnLogin(turnId: string): string | null {
  const m = MEMBER_TURN_RE.exec(turnId);
  return m ? m[1]!.toLowerCase() : null;
}

/** Whether a client's Idempotency-Key may be a turn's stream id: never one
 *  in the member turns' namespace. */
export function streamableKey(key: string): boolean {
  return !key.toLowerCase().startsWith(MEMBER_TURN_PREFIX);
}

/** Whether `login` may open, stop or answer turn `turnId`: a member turn
 *  id of its own, else any other id for an Admin user. */
export async function turnOpenTo(turnId: string, login: ChatCaller): Promise<boolean> {
  if (turnId.toLowerCase().startsWith(MEMBER_TURN_PREFIX)) {
    return memberTurnLogin(turnId) === login.loginId.toLowerCase();
  }
  return chatAdmin(login);
}
