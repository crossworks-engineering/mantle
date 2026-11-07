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
 *   - `delete`: its route is a DELETE, or throws a draft away
 *     (`/discard-draft`);
 *   - `settings`: its row is of an Admin area (`row.area`: settings, users,
 *     assistants, connectors, keys);
 *   - `copy`: it duplicates or copies an item (a copy lands elsewhere);
 *   - `publish`: it commits a draft (`/commit`);
 *   - `admin_only`: its route is open to an Admin user only (`row.open`), or
 *     writes the journal or the contacts, or its body sets an Admin user's
 *     setting of the item (ROUTE_FIELDS_OF: an app's MCP access, read-only
 *     data, trusted tools);
 *   - `listed`: its route is under one of AGENT_REFUSED_PREFIXES or is one of
 *     AGENT_REFUSED_EXACT (the sends, shares, publishes, the login's own
 *     settings, the deletes that are POSTs), or restores an earlier version;
 *   - `tree_move`: it moves an item or a folder in the tree;
 *   - `declared_read`: its route is declared a read (a POST that computes,
 *     a call or a frame ticket): a write in a read's clothes is not let
 *     through on its declaration;
 *   - `workspace_target`: its query names the workspace it lands in (`ws`);
 *   - `sharing_field`: its JSON body has a share, visibility, published,
 *     public, access, members or owner field at any depth (who else reads
 *     an item, whatever the route);
 *   - `move`: its body has a move, copy_to, parentId, folderId, parentPath
 *     or parent field at any depth (any case, `_` or not);
 *   - `sharing_field` too: a `confirm` or `seen` field (the approval of a
 *     write into a shared place);
 *   - a route's own fields (ROUTE_FIELDS_OF): a canvas's source
 *     (`publish`), a file's or folder's indexing (`settings`);
 *   - `move` by its row too: a create that needs a parent named by a move
 *     field (a file, a Files folder, a tree folder), before its body;
 *   - `body_unchecked`: its body is over the route's own ceiling, or a JSON
 *     body's (8 MB): it is not read past that; or it is multipart: refused
 *     unread (an upload is never buffered here, the person sends it);
 *   - a route's own values (ROUTE_BODY_RULES): a table draft op that
 *     deletes a row, column or tab, a task archived, a Stop that supersedes
 *     (`delete`); a folder's place among its siblings (`after`, `listed`)
 *     and a new canvas's source (`publish`) are field rules;
 * A body is checked as JSON whenever it parses as JSON, whatever its
 * content type; a form's fields are checked by name and by any JSON value.
 * The window's own answer to a ui call and a turn's Stop are never refused
 * (AGENT_OPEN_EXACT). The gate asks it once per routed request, after the
 * caller is answered (gate.ts beforeHandler), and hands the handler the
 * request rebuilt from the body it read (checkAgentCall): the body is read
 * once, on Bun and Node alike.
 */
import { AGENT_CALL_HEADER, AGENT_REFUSED_ERROR } from '@mantle/client-types/agent-ui';
import { NextResponse } from '../../server/http-compat';
import { bodyCeilingFor, JSON_BODY_CEILING_BYTES } from '../body-limit';
import { EMBED_SOURCES, embedSharesItem, pathParam, type EmbedShareCheck } from './agent-embeds';
import { isLessonPage, LESSON_ROUTES, type LessonCheck } from './agent-lessons';
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
  // A new chat thread (it ends the chat the agent acts from), and the model
  // calls a click would pay for: a thread's summary, a voice clip's
  // transcript, a Tables import's summary.
  '/api/assistant/threads',
  '/api/assistant/threads/:id/summarize',
  '/api/assistant/transcribe',
  '/api/tables/import',
  // A folder's custom order is everyone's who reads the folder.
  '/api/tree/:kind/place',
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

/** A copy of an item (an app's, a page's, a table's, a drawing's, a
 *  file's duplicate or copy): a copy lands where others may read it. */
const COPY = /\/(?:duplicate|copy)(?:\/|$)/;

/** The creates that need a parent named by a move field (`parentPath`,
 *  `parentId`): a file, a Files folder, a tree folder, and the v1 file
 *  create. A tagged one could never pass the body rule, so the row refuses
 *  it at once (`move`), before its body is read. */
const CREATES_UNDER_A_PARENT =
  /^\/api\/(?:files\/(?:files|folders)|tree\/:kind\/folders|v1\/files)$/;

/** A draft thrown away: what the person wrote since the last commit is
 *  gone (a page's, a table's, a drawing's). */
const DISCARD = /\/discard-draft$/;

/** The body fields of one route that are no content edit, each with its
 *  refusal (matched without case, `_` or `-`): an app's MCP access, its
 *  data's read-only flag and its tools' trust (the author ceiling, an Admin
 *  user's); a canvas's source (live at once for every reader, code); a
 *  file's or folder's indexing (a setting). */
const ROUTE_FIELDS_OF: Readonly<Record<string, Readonly<Record<string, AgentRefusal>>>> = {
  'PATCH /api/apps/:id': {
    mcpaccess: 'admin_only',
    datareadonly: 'admin_only',
    trusttools: 'admin_only',
  },
  'PATCH /api/presents/:id': { source: 'publish' },
  'POST /api/presents': { source: 'publish' },
  'PATCH /api/files/folders/:id': { indexing: 'settings' },
  'PATCH /api/files/files/:id': { indexing: 'settings' },
  // A folder's place among its siblings: the order is everyone's who reads
  // the parent, as POST /api/tree/:kind/place.
  'PATCH /api/tree/:kind/folders/:id': { after: 'listed' },
};

/** The table draft ops that throw something away. */
const DELETE_OPS: ReadonlySet<string> = new Set(['row_delete', 'column_delete', 'tab_delete']);

/** A route's rule on its parsed JSON body by value, beside the field
 *  rules: what one of its fields says, not that it is there. */
const ROUTE_BODY_RULES: Readonly<
  Record<string, (body: Record<string, unknown>) => AgentRefusal | null>
> = {
  // A table draft op that deletes a row, a column or a tab.
  'POST /api/tables/:id/draft-ops': (b) =>
    Array.isArray(b.ops) &&
    b.ops.some(
      (o) =>
        typeof o === 'object' && o !== null && DELETE_OPS.has(String((o as { op?: unknown }).op)),
    )
      ? 'delete'
      : null,
  // Archiving a task takes it out of every list.
  'PATCH /api/tasks/:id': (b) => (b.archived === true ? 'delete' : null),
  'PATCH /api/v1/tasks/:id': (b) => (b.archived === true ? 'delete' : null),
  // A turn's Stop that supersedes: it stamps the person's message and the
  // reply out of the chat's context.
  'POST /api/assistant/turn/:turnId/cancel': (b) => (b.supersede !== undefined ? 'delete' : null),
};

/** Fields that approve a write into a shared place (the visibility
 *  confirm of the tree's files guard, `confirm`, and its `seen` count):
 *  the person confirms who else will read it, never the agent. */
const APPROVAL_FIELDS: ReadonlySet<string> = new Set(['confirm', 'seen']);

/** A draft made the version everyone reads (a page's, a table's, a
 *  drawing's commit). */
const COMMIT = /\/commit$/;

/** The journal and the contacts (and the v1 journal): the Admin user's own
 *  record of people and days, written by the person only, whoever the
 *  route is open to. */
const JOURNAL_CONTACTS = /^\/api\/(?:v1\/)?(?:journal|contacts)(?:\/|$)/;

/** The body fields that move or copy an item somewhere else, at any depth,
 *  matched without case, `_` or `-` (`parent_id`, `parentId`). */
const MOVE_FIELDS: ReadonlySet<string> = new Set([
  'move',
  'copyto',
  'parentid',
  'folderid',
  'parentpath',
  'parent',
]);

/** A move in the tree: an item or a folder to another place, or a page
 *  under another. */
const TREE_MOVE = /^\/api\/(?:tree\/:kind\/move|pages\/:id\/move)$/;

/** Why a tagged request is refused (the 403's `reason`). */
export type AgentRefusal =
  | 'delete'
  | 'settings'
  | 'copy'
  | 'publish'
  | 'admin_only'
  | 'listed'
  | 'tree_move'
  | 'declared_read'
  | 'workspace_target'
  | 'sharing_field'
  | 'move'
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
  if (DISCARD.test(row.pattern)) return 'delete';
  if (method === 'POST' && CREATES_UNDER_A_PARENT.test(row.pattern)) return 'move';
  if (row.area !== null) return 'settings';
  if (COPY.test(row.pattern)) return 'copy';
  if (COMMIT.test(row.pattern)) return 'publish';
  if (JOURNAL_CONTACTS.test(row.pattern)) return 'admin_only';
  if (row.open === 'admin') return 'admin_only';
  if (underPrefix(row.pattern) || AGENT_REFUSED_EXACT.includes(row.pattern)) return 'listed';
  if (RESTORE.test(row.pattern)) return 'listed';
  if (TREE_MOVE.test(row.pattern)) return 'tree_move';
  if (row.effect === 'read') return 'declared_read';
  return null;
}

/** Why a parsed body is refused by its fields, at any depth: a sharing
 *  field (`sharing_field`), a move or copy field (`move`), or null. A body
 *  of a million nodes is not walked to the end: held instead. */
export function bodyFieldRefusal(
  value: unknown,
  routeFields: Readonly<Record<string, AgentRefusal>> = {},
): AgentRefusal | null {
  const stack: unknown[] = [value];
  let seen = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (++seen > 200_000) return 'body_unchecked';
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === 'object') stack.push(x);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const key = k.toLowerCase().replace(/[_-]/g, '');
        if (SHARING_FIELDS.has(key) || APPROVAL_FIELDS.has(key)) return 'sharing_field';
        if (Object.hasOwn(routeFields, key)) return routeFields[key]!;
        if (MOVE_FIELDS.has(key)) return 'move';
        if (x !== null && typeof x === 'object') stack.push(x);
      }
    }
  }
  return null;
}

/** Whether a parsed JSON value holds a sharing field at any depth. */
export function hasSharingField(value: unknown): boolean {
  const r = bodyFieldRefusal(value);
  return r === 'sharing_field' || r === 'body_unchecked';
}

/** A write that names the workspace it lands in (`?ws=`): the person picks
 *  where an item goes, and who reads it with it. */
function queryRefusal(req: Request): AgentRefusal | null {
  return new URL(req.url).searchParams.has('ws') ? 'workspace_target' : null;
}

/** The request's body, at most `max` bytes (null: over it), read once from
 *  the request itself. The caller hands the handler a request rebuilt from
 *  these bytes (rebuilt): a clone is not relied on, as Bun's leaves the
 *  original empty. */
async function bodyBytes(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Refused whole: nobody reads the rest.
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
  return all;
}

/** `req` with `bytes` as its body, from its parts (never `new Request(req,
 *  init)`: under @hono/node-server the handler's request is a stand-in that
 *  undici's brand check refuses, as body-limit.ts capRequestBody says). */
function rebuilt(req: Request, bytes: Uint8Array<ArrayBuffer>): Request {
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: bytes.byteLength > 0 ? bytes : null,
    signal: req.signal,
  });
}

/** Why the body of a tagged write is refused, or null. A body that parses
 *  as JSON is checked as JSON whatever its content type says (a route's
 *  readJson parses it all the same); a form body's fields are checked too
 *  (their names, and each value that is JSON). */
function refusesText(
  type: string,
  text: string,
  routeFields?: Readonly<Record<string, AgentRefusal>>,
): AgentRefusal | null {
  const body = text.replace(/^\uFEFF/, '');
  if (!body.trim()) return null;
  try {
    const byJson = bodyFieldRefusal(JSON.parse(body), routeFields);
    if (byJson) return byJson;
  } catch {
    // Not JSON: a form, or a body the route answers as it would.
  }
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return formFieldRefusal([...new URLSearchParams(body).entries()], routeFields);
  }
  return null;
}

/** Why a form's fields are refused, or null: by their names, and by any
 *  value that is itself JSON. */
function formFieldRefusal(
  fields: readonly (readonly [string, unknown])[],
  routeFields?: Readonly<Record<string, AgentRefusal>>,
): AgentRefusal | null {
  const byName = bodyFieldRefusal(Object.fromEntries(fields.map(([k]) => [k, null])), routeFields);
  if (byName) return byName;
  for (const [, v] of fields) {
    if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) continue;
    try {
      const byValue = bodyFieldRefusal(JSON.parse(v), routeFields);
      if (byValue) return byValue;
    } catch {
      // A text field that only looks like JSON.
    }
  }
  return null;
}

/** A body that parses as a JSON object, or null. */
function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A route's value rule on a body that parses as a JSON object, or null. */
function bodyRuleRefusal(
  text: string,
  rule: (body: Record<string, unknown>) => AgentRefusal | null,
): AgentRefusal | null {
  try {
    const v: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? rule(v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether a request carries the agent header (any value: a call uuid,
 *  `lesson:<uuid>`, or anything else). */
export function agentTagged(req: Request): boolean {
  return req.headers.has(AGENT_CALL_HEADER);
}

/** What the gate does with a request (checkAgentCall): refuse it with the
 *  403, or hand the handler `req` (the request rebuilt from the body the
 *  check read), or nothing to do. */
export type AgentCallCheck = { refused: Response } | { req: Request } | null;

const refusal = (reason: AgentRefusal) => ({
  refused: NextResponse.json({ error: AGENT_REFUSED_ERROR, reason }, { status: 403 }),
});

/** Check an agent-driven request against `row`: its 403, or the request the
 *  handler reads (its body read here once, so it is handed on rebuilt), or
 *  null (untagged, a read, an open route, or no body read). */
export async function checkAgentCall(
  row: Row,
  req: Request,
  deps: { embeds?: EmbedShareCheck; lessons?: LessonCheck } = {},
): Promise<AgentCallCheck> {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (!agentTagged(req)) return null;
  const key = `${method} ${row.pattern}`;
  const bodyRule = ROUTE_BODY_RULES[key];
  // The window's answer and a turn's Stop pass, their bodies unread; a Stop
  // that supersedes is read below by its rule.
  if (AGENT_OPEN_EXACT.includes(row.pattern) && !bodyRule) return null;
  const byRow = AGENT_OPEN_EXACT.includes(row.pattern)
    ? null
    : (agentRefusesRow(row) ?? queryRefusal(req));
  if (byRow) return refusal(byRow);
  if (!req.body) return null;
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  // A tagged multipart body is refused unread: every tagged file create is
  // refused anyway (its parentPath is a move field), and an upload is never
  // buffered here. The window holds it; the person sends it untagged.
  if (type.includes('multipart/')) return refusal('body_unchecked');
  const routeFields = ROUTE_FIELDS_OF[key];
  // Never more than the route's own ceiling (a /s/ route's is 1 MB), nor
  // than a JSON body's: a body over it is refused unread past the cap.
  const path = new URL(req.url).pathname;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A path that does not decode: its spelling's ceiling.
  }
  const cap = Math.min(bodyCeilingFor(decoded) ?? JSON_BODY_CEILING_BYTES, JSON_BODY_CEILING_BYTES);
  const bytes = await bodyBytes(req, cap);
  if (bytes === null) return refusal('body_unchecked');
  const text = new TextDecoder().decode(bytes);
  const byBody = AGENT_OPEN_EXACT.includes(row.pattern)
    ? null
    : refusesText(type, text, routeFields);
  if (byBody) return refusal(byBody);
  const byValue = bodyRule ? bodyRuleRefusal(text, bodyRule) : null;
  if (byValue) return refusal(byValue);
  // A lesson (the Admin workspace's Lessons folder) is code that runs in
  // members' windows: people edit it, never the agent (agent-lessons.ts).
  if (LESSON_ROUTES.test(key)) {
    const page = pathParam(row.pattern, new URL(req.url).pathname);
    // The routed path always names its page; one that names none (a test's
    // stand-in request) has no page to ask about.
    if (page !== null && (await (deps.lessons ?? isLessonPage)(page))) {
      return refusal('publish');
    }
  }
  // An embed by id is a share (agent-embeds.ts): a new embed in a host
  // others read is refused as a sharing field.
  const embeds = EMBED_SOURCES[key];
  if (embeds) {
    const parsed = jsonObject(text);
    const ids = parsed ? embeds.ids(parsed) : [];
    if (ids.length > 0) {
      const host = embeds.host === 'new' ? null : pathParam(row.pattern, new URL(req.url).pathname);
      if (embeds.host === 'id' && host === null) return refusal('sharing_field');
      if (await (deps.embeds ?? embedSharesItem)(host, ids)) return refusal('sharing_field');
    }
  }
  return { req: rebuilt(req, bytes) };
}

/** The 403 for an agent-driven request `row` refuses, or null. Reads the
 *  body of a tagged write: a caller that goes on to a handler uses
 *  checkAgentCall instead, which hands the body on. */
export async function refuseAgentCall(
  row: Row,
  req: Request,
  deps: { embeds?: EmbedShareCheck; lessons?: LessonCheck } = {},
): Promise<Response | null> {
  const out = await checkAgentCall(row, req, deps);
  return out && 'refused' in out ? out.refused : null;
}
