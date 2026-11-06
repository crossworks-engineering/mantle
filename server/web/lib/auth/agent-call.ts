/**
 * The brain's refusal of an agent-driven risky write (docs/agent-ui.md,
 * "The brain refuses, the window holds").
 *
 * While an in-app agent acts in a window (or a lesson plays), every request
 * the page makes that the person did not allow in the window's prompt
 * carries `x-mantle-agent-call`: a call uuid, or `lesson:<uuid>` for a
 * lesson; any value counts as tagged. A tagged request that is not a GET or
 * HEAD is refused 403 `{ error: 'agent_refused', reason }` when any of these
 * holds, whatever the client did (the window then holds it for the person:
 * "Allow once" re-sends it once, untagged):
 *   - `delete`: its route is a DELETE;
 *   - `settings`: its row is of an Admin area (`row.area`: settings, users,
 *     assistants, connectors, keys);
 *   - `admin_only`: its route is open to an Admin user only (`row.open`);
 *   - `listed`: its route is under one of AGENT_REFUSED_PREFIXES or is one of
 *     AGENT_REFUSED_EXACT (the sends, shares, publishes, the login's own
 *     settings, the deletes that are POSTs), or restores an earlier version;
 *   - `tree_move`: it moves an item or a folder in the tree;
 *   - `declared_read`: its route is declared a read (a POST that computes,
 *     a call or a frame ticket): a write in a read's clothes is not let
 *     through on its declaration;
 *   - `sharing_field`: its JSON body has a share, visibility, published,
 *     public, access, members or owner field at any depth (who else reads
 *     an item, whatever the route);
 *   - `body_unchecked`: its body is too large to check.
 * The window's own answer to a ui call and a turn's Stop are never refused
 * (AGENT_OPEN_EXACT). The gate asks it once per routed request, after the
 * caller is answered (gate.ts beforeHandler).
 */
import { AGENT_CALL_HEADER, AGENT_REFUSED_ERROR } from '@mantle/client-types/agent-ui';
import { NextResponse } from '../../server/http-compat';
import { JSON_BODY_CEILING_BYTES } from '../body-limit';
import type { RouteRow } from './route-policy';

/** Route patterns (the manifest's spelling) an agent never writes through,
 *  beside every DELETE and every Admin-area or Admin-only row. A pattern
 *  matches itself and everything below it (`/api/shares` holds
 *  `/api/shares/:id`). */
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
 *  everyone in it; marking it read, below it, stays open). */
export const AGENT_REFUSED_EXACT: readonly string[] = [
  '/api/assistant/turn',
  '/api/assistant/threads/:id/continue',
  '/api/messenger/c/:id',
];

/** Routes never refused: the window's own answer to a ui call, and a
 *  turn's Stop (the person, or the window, ending the turn). */
export const AGENT_OPEN_EXACT: readonly string[] = [
  '/api/assistant/turn/:turnId/ui/:callId',
  '/api/assistant/turn/:turnId/cancel',
];

/** The body fields that change who else reads an item, at any depth,
 *  matched without case, `_` or `-` (`is_public`, `isPublic`). */
const SHARING_FIELDS: ReadonlySet<string> = new Set([
  'share',
  'shares',
  'shared',
  'sharing',
  'visibility',
  'published',
  'publish',
  'public',
  'ispublic',
  'access',
  'members',
  'owner',
]);

/** Restoring an earlier version (a revision, a snapshot, a deleted app, a
 *  grant) puts back what someone removed: the person's step. */
const RESTORE = /\/restore$/;

/** A move in the tree: an item or a folder to another place, or a page
 *  under another. */
const TREE_MOVE = /^\/api\/(?:tree\/:kind\/move|pages\/:id\/move)$/;

/** Why a tagged request is refused (the 403's `reason`). */
export type AgentRefusal =
  | 'delete'
  | 'settings'
  | 'admin_only'
  | 'listed'
  | 'tree_move'
  | 'declared_read'
  | 'sharing_field'
  | 'body_unchecked';

type Row = Pick<RouteRow, 'method' | 'pattern' | 'area' | 'effect' | 'open'>;

function underPrefix(pattern: string): boolean {
  return AGENT_REFUSED_PREFIXES.some((p) => pattern === p || pattern.startsWith(`${p}/`));
}

/** Why a tagged non-GET to `row` is refused by its row alone, or null: the
 *  body is asked next. */
export function agentRefusesRow(row: Row): AgentRefusal | null {
  const method = row.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (AGENT_OPEN_EXACT.includes(row.pattern)) return null;
  if (method === 'DELETE') return 'delete';
  if (row.area !== null) return 'settings';
  if (row.open === 'admin') return 'admin_only';
  if (underPrefix(row.pattern) || AGENT_REFUSED_EXACT.includes(row.pattern)) return 'listed';
  if (RESTORE.test(row.pattern)) return 'listed';
  if (TREE_MOVE.test(row.pattern)) return 'tree_move';
  if (row.effect === 'read') return 'declared_read';
  return null;
}

/** Whether a parsed JSON value holds a sharing field at any depth. */
export function hasSharingField(value: unknown): boolean {
  const stack: unknown[] = [value];
  let seen = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    // A body of a million nodes is not walked to the end: held instead.
    if (++seen > 200_000) return true;
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === 'object') stack.push(x);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (SHARING_FIELDS.has(k.toLowerCase().replace(/[_-]/g, ''))) return true;
        if (x !== null && typeof x === 'object') stack.push(x);
      }
    }
  }
  return false;
}

/** The request's body as text, at most `max` bytes (null: over it), read
 *  from a clone so the handler still reads the original. */
async function bodyText(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Not awaited: a tee branch's cancel settles only once the other
      // branch (the handler's) is cancelled too.
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Why the body of a tagged write is refused, or null. A body that is JSON
 *  (whatever its content type says: a route may parse it all the same) or
 *  a form is checked for sharing fields; a multipart upload is the file
 *  routes' own and is not read here. */
async function refusesBody(req: Request): Promise<AgentRefusal | null> {
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('multipart/')) return null;
  const text = await bodyText(req, JSON_BODY_CEILING_BYTES);
  if (text === null) return 'body_unchecked';
  if (!text.trim()) return null;
  if (type.startsWith('application/x-www-form-urlencoded')) {
    const keys = [...new URLSearchParams(text).keys()];
    return hasSharingField(Object.fromEntries(keys.map((k) => [k, null]))) ? 'sharing_field' : null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the route answers it as it would any other.
    return null;
  }
  return hasSharingField(parsed) ? 'sharing_field' : null;
}

/** Whether a request carries the agent header (any value: a call uuid,
 *  `lesson:<uuid>`, or anything else). */
export function agentTagged(req: Request): boolean {
  return req.headers.has(AGENT_CALL_HEADER);
}

/** The 403 for an agent-driven request `row` refuses, or null. */
export async function refuseAgentCall(row: Row, req: Request): Promise<Response | null> {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (!agentTagged(req)) return null;
  if (AGENT_OPEN_EXACT.includes(row.pattern)) return null;
  const reason = agentRefusesRow(row) ?? (await refusesBody(req));
  if (!reason) return null;
  return NextResponse.json({ error: AGENT_REFUSED_ERROR, reason }, { status: 403 });
}
