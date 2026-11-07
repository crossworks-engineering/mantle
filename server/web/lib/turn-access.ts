/**
 * Whose live turn a turn id is (docs/agent-ui.md, "Turn ids"): the one rule
 * the turn's stream, its Stop and the window's ui answer ask before
 * anything else (app/api/assistant/turn/[turnId]/...).
 *
 * Every streamed turn's id names the login that sent it, minted by POST
 * /api/assistant/turn from the session's login, never from a field the
 * client sends:
 *   - an owner-engine turn (an Admin user's): `turn-<loginId>.<key>`, its
 *     workflow id too;
 *   - a workspace-engine turn (any login, an Admin user's included):
 *     `ws-<loginId>.<key>`, its workflow id too.
 * So the id itself says whose turn it is and nothing is stored for it: such
 * an id is open to that login only, whatever its role. Any other id is
 * nobody's: the same 404 as for a turn that does not exist, an Admin user's
 * included.
 *
 * An Idempotency-Key in either namespace (any case) never becomes a stream
 * id (streamableKey), and a key with a space or a slash cannot be a path
 * segment of the turn's routes, so neither streams.
 */
import type { ChatCaller } from './auth';

/** What every workspace-engine turn id starts with. */
export const MEMBER_TURN_PREFIX = 'ws-';
/** What every owner-engine turn id starts with. */
export const OWNER_TURN_PREFIX = 'turn-';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MEMBER_TURN_RE = new RegExp(`^ws-(${UUID})\\.[^\\s/]+$`, 'i');
const OWNER_TURN_RE = new RegExp(`^turn-(${UUID})\\.[^\\s/]+$`, 'i');

/** The workflow id, and the stream id, of a workspace-engine turn. */
export function memberTurnId(loginId: string, key: string): string {
  return `${MEMBER_TURN_PREFIX}${loginId}.${key}`;
}

/** The workflow id, and the stream id, of an owner-engine turn. */
export function ownerTurnId(loginId: string, key: string): string {
  return `${OWNER_TURN_PREFIX}${loginId}.${key}`;
}

/** The login a workspace-engine turn id names (lower case), or null: not
 *  one. */
export function memberTurnLogin(turnId: string): string | null {
  const m = MEMBER_TURN_RE.exec(turnId);
  return m ? m[1]!.toLowerCase() : null;
}

/** The login any turn id names (lower case), or null: nobody's. */
export function turnLogin(turnId: string): string | null {
  const m = MEMBER_TURN_RE.exec(turnId) ?? OWNER_TURN_RE.exec(turnId);
  return m ? m[1]!.toLowerCase() : null;
}

/** Whether a client's Idempotency-Key may be part of a turn's stream id:
 *  never one in either turn namespace (any case), never one with a space or
 *  a slash (it would not be one path segment). */
export function streamableKey(key: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith(MEMBER_TURN_PREFIX) || k.startsWith(OWNER_TURN_PREFIX)) return false;
  return /^[^\s/]+$/.test(key);
}

/** Whether `login` may open, stop or answer turn `turnId`: only a turn id
 *  that names it. */
export function turnOpenTo(turnId: string, login: Pick<ChatCaller, 'loginId'>): boolean {
  const named = turnLogin(turnId);
  return named !== null && named === login.loginId.toLowerCase();
}
