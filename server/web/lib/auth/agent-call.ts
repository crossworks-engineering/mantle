/**
 * The brain's refusal of an agent-driven risky write (docs/agent-ui.md).
 *
 * While an in-app agent acts in a window, every request the page makes that
 * the person did not allow in the window's prompt carries
 * `x-mantle-agent-call: <callId>`. A request that is not a read and carries
 * it is refused 403 `{ error: 'needs_user' }` when its route deletes, sends,
 * shares, publishes or changes a setting, whatever the client did: the
 * person makes those themselves. The gate asks it once per routed request,
 * after the caller is answered (gate.ts beforeHandler).
 *
 * The route declarations say read or write, not which kind of write, so the
 * kinds are read from the row this way:
 *   - a DELETE: a delete;
 *   - a row of an Admin area (`row.area`: settings, users, assistants,
 *     connectors, keys): a settings change;
 *   - a route under one of AGENT_REFUSED_PREFIXES: the sends, shares,
 *     publishes, the login's own settings and the writes named "delete" or
 *     "clear" that are POSTs (listed, so a new such route is added here).
 * A row whose effect is `read` (a GET, or a POST that only computes) is
 * never refused.
 */
import { AGENT_CALL_HEADER } from '@mantle/client-types/agent-ui';
import { NextResponse } from '../../server/http-compat';
import type { RouteRow } from './route-policy';

/** Route patterns (the manifest's spelling) an agent never writes through,
 *  beside every DELETE and every Admin-area row. A pattern matches itself
 *  and everything below it (`/api/shares` holds `/api/shares/:id`). */
export const AGENT_REFUSED_PREFIXES: readonly string[] = [
  // Shares and access: who else reads an item.
  '/api/shares',
  '/api/grants',
  '/api/contacts/:id/sharing',
  '/api/workspaces',
  // Publishing.
  '/api/apps/:id/publish',
  // Sends: a message, a call, a chat with someone, a pairing.
  '/api/messenger/conversations',
  '/api/messenger/c/:id/messages',
  '/api/messenger/c/:id/participants',
  '/api/messenger/c/:id/call',
  '/api/messenger/c/:id/leave',
  // Typing tells the other people of the chat that the person is writing.
  '/api/messenger/c/:id/typing',
  '/api/telegram',
  // Deletes that are POSTs.
  '/api/messenger/c/:id/clear',
  '/api/messenger/c/:id/history/delete',
  // The login's own settings, its sign-in, its keys and devices.
  '/api/profile',
  '/api/auth',
  '/api/access-keys',
  '/api/oauth',
  '/api/push',
  '/api/member/push',
  '/api/app-nav',
  // Audit round (phase 3): publishing a recall map is a field of its PATCH,
  // so every recall map write; merging entities; an app's tool broker (an
  // app the agent opens would run its declared tools).
  '/api/recall/maps',
  '/api/entities/merge',
  '/api/apps/:id/tool-broker',
];

/** Routes refused as themselves only, not what is below them: a new turn
 *  (the agent typing into the chat and sending), continuing a thread, and
 *  a chat's own writes (its PATCH renames it or changes its settings for
 *  everyone in it; marking it read, below it, stays open). The window's own
 *  answer (`/api/assistant/turn/:turnId/ui/:callId`) and a turn's cancel
 *  stay open. */
export const AGENT_REFUSED_EXACT: readonly string[] = [
  '/api/assistant/turn',
  '/api/assistant/threads/:id/continue',
  '/api/messenger/c/:id',
];

/** Restoring an earlier version (a revision, a snapshot, a deleted app, a
 *  grant) puts back what someone removed: the person's step. */
const RESTORE = /\/restore$/;

function underPrefix(pattern: string): boolean {
  return AGENT_REFUSED_PREFIXES.some((p) => pattern === p || pattern.startsWith(`${p}/`));
}

/** Whether `row` is a delete, send, share, publish or settings change, which
 *  an agent-driven request may not make. */
export function agentRefusesRow(
  row: Pick<RouteRow, 'method' | 'pattern' | 'area' | 'effect'>,
): boolean {
  if (row.effect === 'read') return false;
  if (row.method.toUpperCase() === 'DELETE') return true;
  if (row.area !== null) return true;
  return (
    underPrefix(row.pattern) ||
    AGENT_REFUSED_EXACT.includes(row.pattern) ||
    RESTORE.test(row.pattern)
  );
}

/** The 403 for an agent-driven request to a refused row, or null. */
export function refuseAgentCall(
  row: Pick<RouteRow, 'method' | 'pattern' | 'area' | 'effect'>,
  req: Request,
): Response | null {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (!req.headers.has(AGENT_CALL_HEADER)) return null;
  if (!agentRefusesRow(row)) return null;
  return NextResponse.json({ error: 'needs_user' }, { status: 403 });
}
