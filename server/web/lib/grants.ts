/**
 * The Grant Access panel's API (workspaces plan page 4887b8e7, phase W5b2;
 * sections 1.3, 2.3, 7.1, 8.1, R1, S5, S6, S7, 18.8, 19.5, 21.8).
 *
 * An item is shared by a grant to a workspace, each with its own Write
 * switch. Every item has ONE home workspace (R1); its Moderators manage the
 * item. Who may do what:
 *  - add a grant to T, restore one taken away, turn a folder-derived row
 *    into a hand grant ("Change here"), switch Write on: a Moderator of the
 *    home AND of T;
 *  - remove a grant from T, switch Write off: a Moderator of the home OR of
 *    T (it only narrows);
 *  - the home row is never removed (move the item instead);
 *  - move the home from H to T: a Moderator of H and of T (decision 4);
 *  - place items in a folder: may edit the folder and manage the item (S6);
 *    an app that gains a holder that way also needs Moderator of each new
 *    holder and the confirm (18.8, S7).
 * A folder passes its grants to everything inside it (rows "via folder");
 * taking a folder-derived row away writes an exclusion ("Removed here")
 * that Restore clears (19.5). A folder change needs the confirm and is
 * refused above FOLDER_GRANT_LIMIT.max items (S5).
 *
 * Grants are the only truth since W5b2 part B (0261 turned the level bridge
 * off): every row, the ones the bridge once wrote included, is changed here.
 *
 * Every write takes the heads of what it changes FIRST (a folder: its whole
 * subtree), in one transaction retried whole on a busy head or a deadlock
 * (U1, V1). Every change writes a workspace_events row. An item or a
 * workspace the caller may not see is 404, never 403.
 */
import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import {
  db,
  sql,
  isCheckViolation,
  lockMoreHeads,
  withDeadlockRetry,
  withHeads,
  withSubtreeHeads,
  asSystem,
} from '@mantle/db';
import type {
  GrantContactShare,
  GrantEmbed,
  GrantEmbedSkip,
  GrantErrorCode,
  GrantMovePreviewResponse,
  GrantMoveResponse,
  GrantPreviewResponse,
  GrantRow,
  GrantServedRef,
  GrantsResponse,
  GrantsWriteResponse,
  GrantWorkspaceRef,
} from '@mantle/client-types';
import { TREE_KIND_SPECS, type TreeKind } from '@mantle/client-types/tree';
import {
  canShareNode,
  contactSharesForNode,
  EMBEDDING_KINDS,
  getActiveShareForNode,
  listServeCandidates,
} from '@mantle/content';
import { appDbTableDetails } from '@mantle/content/app-broker';
import { refoldPageTexts } from '@mantle/content/pages';
import { moveTreeItems, notifyTreeChanged } from '@mantle/content/tree';
import { publicErrorMessage } from '@mantle/std';
import type { AnyLogin } from '@/lib/auth';
import { areasFor, workspaceCaller, WsError, type WsCaller } from '@/lib/workspaces';

// ── Errors and the route wrapper ─────────────────────────────────────────────

export class GrantError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: GrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

const ITEM_NOT_FOUND = () => new GrantError(404, 'not_found', 'Item not found.');
const WS_NOT_FOUND = () => new GrantError(404, 'not_found', 'Workspace not found.');

/** A folder change is refused above `max` items (S5: the measured
 *  50,000-item folder change stays well under a minute). An object so a
 *  test can lower it. */
export const FOLDER_GRANT_LIMIT = { max: 50_000 };

/** Run a grants route for the login the handler read (loginCaller()):
 *  answer the result as JSON or a refusal as `{ error, code }`. Anything
 *  else throws (opaque 500). */
export async function grantsRoute(
  login: AnyLogin,
  fn: (caller: WsCaller) => Promise<unknown>,
  okStatus = 200,
): Promise<Response> {
  const caller = workspaceCaller(login);
  try {
    // The rule is in this library's own SQL on the system pool: it leaves
    // the request scope the gate entered by name (W6a).
    const out = await asSystem(() => fn(caller), 'rule-in-query');
    return NextResponse.json(out, { status: okStatus });
  } catch (err) {
    if (err instanceof GrantError || err instanceof WsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that is not a uuid names nothing: 404. */
export function itemId(id: string): string {
  if (!UUID_RE.test(id)) throw ITEM_NOT_FOUND();
  return id.toLowerCase();
}

function workspaceId(id: string): string {
  if (!UUID_RE.test(id)) throw WS_NOT_FOUND();
  return id.toLowerCase();
}

/** `?confirm=1` (or true) on a DELETE, restore or hand. */
export function confirmParam(req: Request): boolean {
  const v = new URL(req.url).searchParams.get('confirm');
  return v === '1' || v === 'true';
}

type Exec = { execute: (typeof db)['execute'] };

async function rows<T>(q: Exec, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await q.execute(query)) as unknown as T[];
}

/** A Postgres uuid[] literal of ids already checked. */
function uuidList(ids: Iterable<string>): string {
  const out = [...ids];
  for (const id of out) if (!UUID_RE.test(id)) throw new Error('uuidList: not a uuid');
  return `{${out.join(',')}}`;
}

/** A uuid[] column as the driver hands it back (an array, or its text). */
function idsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    const inner = v.replace(/^\{|\}$/g, '');
    return inner ? inner.split(',').map((s) => s.trim()) : [];
  }
  return [];
}

// ── The caller ───────────────────────────────────────────────────────────────

type Mine = { id: string; name: string; isAdmin: boolean; moderator: boolean };

type Ctx = {
  caller: WsCaller;
  /** The caller's live workspaces. */
  mine: Map<string, Mine>;
  /** An Admin user with the 'users' area: sees every workspace's name. */
  seesAll: boolean;
  /** A user of the Admin workspace. */
  adminUser: boolean;
};

async function loadCtx(caller: WsCaller, q: Exec = db): Promise<Ctx> {
  const [a] = await rows<{ id: string }>(
    q,
    sql`select id from workspaces where owner_id = ${caller.anchorId} and is_admin limit 1`,
  );
  if (!a) throw new GrantError(409, 'not_migrated', 'Workspaces are not set up on this brain yet.');
  const list = await rows<{ id: string; name: string; is_admin: boolean; moderator: boolean }>(
    q,
    sql`select w.id, w.name, w.is_admin, u.moderator
          from workspaces w
          join workspace_users u on u.workspace_id = w.id and u.login_id = ${caller.loginId}
         where w.owner_id = ${caller.anchorId} and w.archived_at is null`,
  );
  const mine = new Map<string, Mine>(
    list.map((w) => [
      w.id,
      { id: w.id, name: w.name, isAdmin: w.is_admin, moderator: w.moderator },
    ]),
  );
  const areas = await areasFor(caller);
  return {
    caller,
    mine,
    seesAll: areas.includes('users'),
    adminUser: list.some((w) => w.is_admin),
  };
}

const myIds = (ctx: Ctx) => [...ctx.mine.keys()];
const isMod = (ctx: Ctx, ws: string | null) => !!ws && ctx.mine.get(ws)?.moderator === true;

/** A live workspace the caller may see (a user of it, or an Admin user),
 *  else 404. */
async function seeTarget(ctx: Ctx, wsId: string, q: Exec = db): Promise<GrantWorkspaceRef> {
  const id = workspaceId(wsId);
  const own = ctx.mine.get(id);
  if (own) return { wsId: own.id, name: own.name };
  if (ctx.seesAll) {
    const [w] = await rows<{ id: string; name: string }>(
      q,
      sql`select id, name from workspaces
           where id = ${id} and owner_id = ${ctx.caller.anchorId} and archived_at is null`,
    );
    if (w) return { wsId: w.id, name: w.name };
  }
  throw WS_NOT_FOUND();
}

// ── The item ─────────────────────────────────────────────────────────────────

type Item = {
  id: string;
  type: string;
  title: string;
  path: string | null;
  home: string | null;
  readWs: string[];
  writeWs: string[];
  /** The folder it sits in (a folder: the one above it). */
  parent: string | null;
};

type GrantDbRow = {
  ws: string;
  name: string;
  write: boolean;
  isHome: boolean;
  via: string | null;
  excluded: boolean;
};

/** The item if the caller reads it (one of its workspaces holds a grant),
 *  else 404. */
async function loadItem(ctx: Ctx, id: string, q: Exec = db): Promise<Item> {
  const [n] = await rows<{
    id: string;
    type: string;
    title: string;
    path: string | null;
    home_ws: string | null;
    read_ws: unknown;
    write_ws: unknown;
    parent: string | null;
  }>(
    q,
    sql`select n.id, n.type::text as type, n.title, n.path::text as path, n.home_ws,
               n.read_ws, n.write_ws,
               mantle_parent_folder(n.owner_id, n.type, n.path) as parent
          from nodes n
         where n.id = ${itemId(id)} and n.owner_id = ${ctx.caller.anchorId}`,
  );
  if (!n) throw ITEM_NOT_FOUND();
  const item: Item = {
    id: n.id,
    type: n.type,
    title: n.title,
    path: n.path,
    home: n.home_ws,
    readWs: idsOf(n.read_ws),
    writeWs: idsOf(n.write_ws),
    parent: n.parent,
  };
  if (!item.readWs.some((w) => ctx.mine.has(w))) throw ITEM_NOT_FOUND();
  return item;
}

async function grantRows(q: Exec, nodeId: string): Promise<Map<string, GrantDbRow>> {
  const list = await rows<{
    ws: string;
    name: string;
    write: boolean;
    is_home: boolean;
    via: string | null;
    excluded: boolean;
  }>(
    q,
    sql`select g.workspace_id as ws, w.name, g.write, g.is_home, g.via_folder_id as via,
               g.excluded
          from item_grants g join workspaces w on w.id = g.workspace_id
         where g.node_id = ${nodeId}`,
  );
  return new Map(
    list.map((r) => [
      r.ws,
      {
        ws: r.ws,
        name: r.name,
        write: r.write,
        isHome: r.is_home,
        via: r.via,
        excluded: r.excluded,
      },
    ]),
  );
}

const mayManage = (ctx: Ctx, item: Item) => isMod(ctx, item.home);
const mayEdit = (ctx: Ctx, item: Item) =>
  mayManage(ctx, item) || item.writeWs.some((w) => ctx.mine.has(w));

/** Whether the item's folder passes `ws` on to it (a non-excluded row of
 *  the folder, for a kind that may take it from a folder). */
async function folderGrants(q: Exec, item: Item, ws: string): Promise<boolean> {
  if (!item.parent) return false;
  const [r] = await rows<{ ok: boolean }>(
    q,
    sql`select exists (
          select 1 from item_grants g
           where g.node_id = ${item.parent} and g.workspace_id = ${ws} and not g.excluded
             and mantle_grant_kind_ok(${item.type}::node_type, ${ws}::uuid, true)) as ok`,
  );
  return r?.ok === true;
}

async function kindOk(q: Exec, type: string, ws: string): Promise<boolean> {
  const [r] = await rows<{ ok: boolean }>(
    q,
    sql`select mantle_grant_kind_ok(${type}::node_type, ${ws}::uuid) as ok`,
  );
  return r?.ok === true;
}

async function subtreeCount(q: Exec, anchorId: string, item: Item): Promise<number> {
  if (item.type !== 'branch' || !item.path) return 1;
  const [r] = await rows<{ n: number }>(
    q,
    sql`select count(*)::int as n from nodes
         where owner_id = ${anchorId} and path <@ ${item.path}::ltree`,
  );
  return r?.n ?? 1;
}

async function event(
  q: Exec,
  ws: string,
  actor: string,
  action: string,
  subject: Record<string, unknown>,
): Promise<void> {
  // A definer (0279): a write-role caller holds no right on workspace_events.
  await q.execute(
    sql`select mantle_workspace_event(${ws}::uuid, ${actor}::uuid, ${action},
                                      ${JSON.stringify(subject)}::jsonb)`,
  );
}

/** One grant row changed by the panel's rules (0279, mantle_grant_change):
 *  a definer, so a write-role caller never writes the derived columns
 *  (via_folder_id, granted_by, granted_at). */
async function grantChange(
  q: Exec,
  op: 'add' | 'exclude' | 'hand' | 'write' | 'remove' | 'restore',
  node: string,
  ws: string,
  write: boolean,
  actor: string,
): Promise<void> {
  await q.execute(
    sql`select mantle_grant_change(${op}, ${node}::uuid, ${ws}::uuid, ${write}, ${actor}::uuid)`,
  );
}

// ── Reading: the panel ───────────────────────────────────────────────────────

async function buildResponse(ctx: Ctx, item: Item, q: Exec = db): Promise<GrantsResponse> {
  const manage = mayManage(ctx, item);
  const mine = uuidList(myIds(ctx));
  const list = await rows<{
    ws: string;
    name: string;
    write: boolean;
    is_home: boolean;
    via: string | null;
    via_title: string | null;
    via_readable: boolean | null;
    excluded: boolean;
    derivable: boolean;
  }>(
    q,
    sql`select g.workspace_id as ws, w.name, g.write, g.is_home, g.via_folder_id as via,
               f.title as via_title, (f.read_ws && ${mine}::uuid[]) as via_readable,
               g.excluded,
               (${item.parent}::uuid is not null and exists (
                  select 1 from item_grants fg
                   where fg.node_id = ${item.parent}::uuid and fg.workspace_id = g.workspace_id
                     and not fg.excluded)
                and mantle_grant_kind_ok(${item.type}::node_type, g.workspace_id, true)) as derivable
          from item_grants g
          join workspaces w on w.id = g.workspace_id
          left join nodes f on f.id = g.via_folder_id
         where g.node_id = ${item.id}
         order by g.is_home desc, lower(w.name), g.workspace_id`,
  );
  let parentFolder: { id: string; title: string | null } | null = null;
  if (item.parent && list.some((r) => r.excluded && r.derivable)) {
    const [p] = await rows<{ title: string; readable: boolean }>(
      q,
      sql`select title, read_ws && ${mine}::uuid[] as readable from nodes where id = ${item.parent}`,
    );
    parentFolder = { id: item.parent, title: p?.readable ? p.title : null };
  }
  const shown = (ws: string) => ctx.mine.has(ws) || ctx.seesAll || manage;
  const out: GrantRow[] = [];
  for (const r of list) {
    if (!shown(r.ws)) continue;
    // "Removed here" only means something while the folder grants it.
    if (r.excluded && !r.derivable) continue;
    out.push({
      wsId: r.ws,
      name: r.name,
      write: r.excluded ? false : r.write,
      isHome: r.is_home,
      viaFolder: r.excluded
        ? parentFolder
        : r.via
          ? { id: r.via, title: r.via_readable ? r.via_title : null }
          : null,
      excluded: r.excluded,
    });
  }

  const homeRow = list.find((r) => r.is_home);
  // A home the caller may not name is not identified either (audit L4).
  const homeShown = !!homeRow && (ctx.mine.has(homeRow.ws) || ctx.seesAll);
  const home = {
    wsId: homeShown ? homeRow.ws : null,
    name: homeShown ? homeRow.name : null,
  };

  let addable: GrantWorkspaceRef[] = [];
  if (manage) {
    const taken = new Set(list.filter((r) => !r.excluded).map((r) => r.ws));
    const mods = [...ctx.mine.values()].filter((w) => w.moderator && !taken.has(w.id));
    if (mods.length) {
      const ok = await rows<{ id: string }>(
        q,
        sql`select x.id from unnest(${uuidList(mods.map((w) => w.id))}::uuid[]) as x(id)
             where mantle_grant_kind_ok(${item.type}::node_type, x.id)`,
      );
      const okSet = new Set(ok.map((r) => r.id));
      addable = mods
        .filter((w) => okSet.has(w.id))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
        .map((w) => ({ wsId: w.id, name: w.name }));
    }
  }

  const anchor = ctx.caller.anchorId;
  const canLink = canShareNode({ type: item.type, path: item.path });
  const mayLink = canLink && (item.type === 'app' ? manage : mayEdit(ctx, item));
  const share = canLink ? await getActiveShareForNode(anchor, item.id) : null;
  let contactShares: GrantContactShare[] | null = null;
  if (mayLink && ctx.adminUser && item.type !== 'branch') {
    contactShares = await contactSharesForNode(anchor, item.id);
  }

  let embedsNotGranted: GrantEmbed[] = [];
  if (EMBEDDING_KINDS.includes(item.type) && item.readWs.length) {
    embedsNotGranted = await missingEmbeds(ctx, item, q);
  }

  const body: GrantsResponse = {
    item: { id: item.id, title: item.title, type: item.type },
    home,
    rows: out,
    addable,
    mayManage: manage,
    mayLink,
    hasLink: share !== null,
    link:
      mayLink && share
        ? {
            id: share.id,
            path: `/s/${share.token}`,
            served: await servedRefs(ctx, share.served, q),
          }
        : null,
    serveCandidates: mayLink ? await listServeCandidates(anchor, ctx.caller.loginId, item) : [],
    contactShares,
    embedsNotGranted,
  };
  if (item.type === 'branch' && mayEdit(ctx, item)) {
    // What a new item placed here takes (S6, 21.8 row 1): every row of the
    // folder not removed here, named even where the caller is not a user,
    // so the create dialog can say every workspace it will reach. The same
    // rule as the insert trigger of 0261 (a live workspace that may hold the
    // folder's kind; an archived one gains nothing).
    const kind = treeKindOf(item.path);
    const nodeType = kind ? TREE_KIND_SPECS[kind].nodeType : null;
    body.placesInto = nodeType
      ? (
          await rows<{ id: string; name: string }>(
            q,
            sql`select w.id, w.name from item_grants g join workspaces w on w.id = g.workspace_id
                 where g.node_id = ${item.id} and not g.excluded and w.archived_at is null
                   and mantle_grant_kind_ok(${nodeType}::node_type, w.id, true)
                 order by lower(w.name), w.id`,
          )
        ).map((w) => ({ wsId: w.id, name: w.name }))
      : [];
  }
  if (item.type === 'app') {
    const [a] = await rows<{ mcp: boolean }>(
      q,
      sql`select mcp_access as mcp from apps where node_id = ${item.id}`,
    );
    body.app = { mcpAccess: a?.mcp === true };
  }
  return body;
}

/** A link's served list as the panel names it, in its order: the title
 *  only where the caller reads the item (null otherwise, and for an id with
 *  no item left). */
async function servedRefs(ctx: Ctx, served: readonly string[], q: Exec): Promise<GrantServedRef[]> {
  const ids = served.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  if (!ids.length) return [];
  const found = await rows<{ id: string; title: string; readable: boolean }>(
    q,
    sql`select id::text as id, title, read_ws && ${uuidList(myIds(ctx))}::uuid[] as readable
          from nodes
         where owner_id = ${ctx.caller.anchorId} and id = any (${uuidList(ids)}::uuid[])`,
  );
  const titles = new Map(
    found.map((r) => [r.id.toLowerCase(), r.readable === true ? r.title : null]),
  );
  return ids.map((id) => ({ nodeId: id, title: titles.get(id) ?? null }));
}

type EmbedRow = { id: string; title: string; type: string; read_ws: unknown };

/** What a page, drawing or note embeds that is not granted to every
 *  workspace the item is: only embeds the caller may open. */
async function embedRows(ctx: Ctx, item: Item, q: Exec): Promise<EmbedRow[]> {
  return rows<EmbedRow>(
    q,
    sql`select e.id, e.title, e.type::text as type, e.read_ws
          from node_embeds ne join nodes e on e.id = ne.to_id
         where ne.from_id = ${item.id} and e.owner_id = ${ctx.caller.anchorId}
           and e.type <> 'branch'
           and e.read_ws && ${uuidList(myIds(ctx))}::uuid[]
           and exists (select 1 from unnest(${uuidList(item.readWs)}::uuid[]) as w(id)
                        where not (w.id = any (e.read_ws)))
         order by lower(e.title), e.id`,
  );
}

async function missingEmbeds(ctx: Ctx, item: Item, q: Exec): Promise<GrantEmbed[]> {
  return (await embedRows(ctx, item, q)).map((e) => ({
    nodeId: e.id,
    title: e.title,
    kind: e.type,
  }));
}

/** GET /api/grants/:nodeId. */
export async function getGrants(caller: WsCaller, nodeId: string): Promise<GrantsResponse> {
  const ctx = await loadCtx(caller);
  return buildResponse(ctx, await loadItem(ctx, nodeId));
}

/** The panel after a change, or `{ visible: false }` when the caller no
 *  longer reads the item. */
async function after(caller: WsCaller, nodeId: string): Promise<GrantsWriteResponse> {
  try {
    return await getGrants(caller, nodeId);
  } catch (err) {
    if (err instanceof GrantError && err.code === 'not_found') return { visible: false };
    throw err;
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** A database refusal said plainly, or null. */
function dbRefusal(err: unknown): GrantError | null {
  if (!isCheckViolation(err)) return null;
  for (let e: unknown = err, d = 0; e && d < 4; d++) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') {
      if (m.includes('Admin workspace only')) {
        return new GrantError(
          409,
          'kind_not_allowed',
          'This kind of item lives in the Admin workspace only.',
        );
      }
      if (m.includes('is archived')) return WS_NOT_FOUND();
      if (m.includes('personal space')) return ITEM_NOT_FOUND();
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

type Change = {
  /** A folder needs the confirm (every folder change is held to the size
   *  limit, the confirm or not: a change on a folder reaches its subtree). */
  folderConfirm: boolean;
  /** An app also needs it (a new holder: S7). */
  appConfirm?: boolean;
  confirm: boolean;
};

type Grants = Map<string, GrantDbRow>;

/** The rules of one change: throws the refusal (404, 403, 409) or answers
 *  what `apply` needs. Read-only. */
type Check<T> = (q: Exec, ctx: Ctx, item: Item, grants: Grants) => Promise<T>;

/**
 * Run one change of `nodeId`'s grants. The rules (`check`) run first on a
 * plain read, so a caller who may not make the change learns nothing more
 * (no counts, no confirm: audit M1). Then the size limit and the confirm.
 * Then, in ONE transaction whose first lock is the heads (the item, or a
 * folder's whole subtree), the rules again on a fresh read and `apply`.
 * Retried whole on a busy head or a deadlock.
 */
async function change<T>(
  caller: WsCaller,
  nodeId: string,
  opts: Change,
  check: Check<T>,
  apply: (tx: Exec, ctx: Ctx, item: Item, grants: Grants, checked: T) => Promise<void>,
): Promise<GrantsWriteResponse> {
  const ctx0 = await loadCtx(caller);
  const item0 = await loadItem(ctx0, nodeId);
  await check(db, ctx0, item0, await grantRows(db, item0.id));
  const folder = item0.type === 'branch';
  if (folder) {
    const total = await subtreeCount(db, caller.anchorId, item0);
    if (total > FOLDER_GRANT_LIMIT.max) {
      throw new GrantError(
        409,
        'too_big',
        `This folder holds ${total.toLocaleString('en')} items. Share its sub-folders one by one.`,
      );
    }
    if (opts.folderConfirm && !opts.confirm) {
      throw new GrantError(
        409,
        'confirm_required',
        `This changes access for ${total.toLocaleString('en')} items. Confirm to go ahead.`,
      );
    }
  }
  if (item0.type === 'app' && opts.appConfirm && !opts.confirm) {
    throw new GrantError(
      409,
      'confirm_required',
      'This app’s data becomes visible to that workspace, and the app then reads only items every holder reads. Confirm to go ahead.',
    );
  }
  const run = async (tx: Exec) => {
    const ctx = await loadCtx(caller, tx);
    const item = await loadItem(ctx, item0.id, tx);
    const grants = await grantRows(tx, item.id);
    await apply(tx, ctx, item, grants, await check(tx, ctx, item, grants));
  };
  try {
    await withDeadlockRetry(() =>
      folder ? withSubtreeHeads(item0.id, [], run) : withHeads([item0.id], 'update', run),
    );
  } catch (err) {
    throw dbRefusal(err) ?? err;
  }
  await refoldAfter(caller.anchorId, [item0]);
  return after(caller, item0.id);
}

/**
 * Page texts after a grant change (plan 5.3): a page's indexed text names
 * another item only when every holder of the page holds it, so the pages
 * concerned are folded again: the item (a folder: the pages inside it) and
 * every page that names it. After the commit, in batches; text only, never
 * LLM work. Best effort: a failure is logged, the change stands, and the
 * page's next save folds it again.
 */
async function refoldAfter(
  anchorId: string,
  items: ReadonlyArray<{ id: string; type: string; path: string | null }>,
): Promise<void> {
  try {
    const ids: string[] = [];
    for (const item of items) {
      if (item.type === 'branch' && item.path) {
        const inside = await rows<{ id: string }>(
          db,
          sql`select id from nodes
               where owner_id = ${anchorId} and type = 'page' and path <@ ${item.path}::ltree`,
        );
        ids.push(...inside.map((r) => r.id));
      } else {
        ids.push(item.id);
      }
    }
    for (let i = 0; i < ids.length; i += 200) {
      await refoldPageTexts(anchorId, ids.slice(i, i + 200));
    }
  } catch (err) {
    console.error('[grants] page text refold failed:', publicErrorMessage(err, 'grants refold'));
  }
}

const NOT_MANAGER = () =>
  new GrantError(
    403,
    'forbidden',
    'Only a Moderator of this item’s home workspace can share it there.',
  );

/** POST /api/grants/:nodeId: grant the item to `wsId` ("Add workspace").
 *  An exclusion there ("Removed here") becomes a grant set on the item. */
export async function addGrant(
  caller: WsCaller,
  nodeId: string,
  body: { wsId: string; write?: boolean; confirm?: boolean },
): Promise<GrantsWriteResponse> {
  return change(
    caller,
    nodeId,
    { folderConfirm: true, appConfirm: true, confirm: body.confirm === true },
    async (q, ctx, item, grants) => {
      const t = await seeTarget(ctx, body.wsId, q);
      if (!mayManage(ctx, item)) throw NOT_MANAGER();
      if (!isMod(ctx, t.wsId)) {
        throw new GrantError(
          403,
          'forbidden',
          'Only a Moderator of that workspace can add items to it.',
        );
      }
      const row = grants.get(t.wsId);
      if (row && !row.excluded) {
        throw new GrantError(409, 'already_granted', 'The item is already in that workspace.');
      }
      if (!(await kindOk(q, item.type, t.wsId))) {
        throw new GrantError(
          409,
          'kind_not_allowed',
          'This kind of item lives in the Admin workspace only.',
        );
      }
      return t;
    },
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, _grants, t) => {
      const write = body.write === true;
      await grantChange(tx, 'add', item.id, t.wsId, write, ctx.caller.loginId);
      await event(tx, t.wsId, ctx.caller.loginId, 'grant.add', { node: item.id, write });
    },
  );
}

/** A grant row of the item for a workspace the caller may see, or 404. */
function rowFor(
  ctx: Ctx,
  item: Item,
  grants: Map<string, GrantDbRow>,
  wsId: string,
): GrantDbRow | null {
  const id = workspaceId(wsId);
  const row = grants.get(id) ?? null;
  // The panel's rule: a workspace the caller is not in is there only for an
  // Admin user, or for a manager of the item when the item holds a row.
  const visible = ctx.mine.has(id) || ctx.seesAll || (row !== null && mayManage(ctx, item));
  if (!visible) throw WS_NOT_FOUND();
  return row;
}

const NOT_GRANTED = () =>
  new GrantError(404, 'not_granted', 'The item is not granted to that workspace.');

/** PATCH /api/grants/:nodeId/:wsId: the Write switch. */
export async function patchGrant(
  caller: WsCaller,
  nodeId: string,
  wsId: string,
  body: { write: boolean; confirm?: boolean },
): Promise<GrantsWriteResponse> {
  return change(
    caller,
    nodeId,
    { folderConfirm: true, confirm: body.confirm === true },
    async (_q, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row || row.excluded) throw NOT_GRANTED();
      if (row.via) {
        throw new GrantError(
          409,
          'derived_row',
          'This grant comes from the folder. Use Change here first.',
        );
      }
      const manage = mayManage(ctx, item);
      const allowed = row.isHome
        ? manage
        : body.write
          ? manage && isMod(ctx, row.ws)
          : manage || isMod(ctx, row.ws);
      if (!allowed) {
        throw new GrantError(403, 'forbidden', 'You may not change Write on this grant.');
      }
      return row;
    },
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, _grants, row) => {
      if (row.write === body.write) return;
      await grantChange(tx, 'write', item.id, row.ws, body.write, ctx.caller.loginId);
      await event(tx, row.ws, ctx.caller.loginId, 'grant.write', {
        node: item.id,
        write: body.write,
      });
    },
  );
}

/** DELETE /api/grants/:nodeId/:wsId ("Remove from this workspace"). A
 *  folder-derived row, or a hand row the folder would bring straight back,
 *  becomes "Removed here". */
export async function removeGrant(
  caller: WsCaller,
  nodeId: string,
  wsId: string,
  confirm: boolean,
): Promise<GrantsWriteResponse> {
  return change(
    caller,
    nodeId,
    { folderConfirm: true, confirm },
    async (_q, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row || row.excluded) throw NOT_GRANTED();
      if (row.isHome) {
        throw new GrantError(
          409,
          'home_row',
          'This is the item’s home. Move the item to another workspace instead.',
        );
      }
      if (!mayManage(ctx, item) && !isMod(ctx, row.ws)) {
        throw new GrantError(403, 'forbidden', 'You may not remove the item from that workspace.');
      }
      return row;
    },
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, _grants, row) => {
      const exclude = row.via !== null || (await folderGrants(tx, item, row.ws));
      // Logged first, while the row is there: an event in a workspace
      // outside the caller's scope needs that workspace's grant row on the
      // item (mantle_workspace_event, A2b2b fix round 2, L3).
      await event(tx, row.ws, ctx.caller.loginId, 'grant.remove', {
        node: item.id,
        excluded: exclude,
        ...(row.via ? { folder: row.via } : {}),
      });
      await grantChange(
        tx,
        exclude ? 'exclude' : 'remove',
        item.id,
        row.ws,
        false,
        ctx.caller.loginId,
      );
    },
  );
}

/** POST /api/grants/:nodeId/:wsId/restore: take "Removed here" away, so the
 *  folder's grant reaches the item again. */
export async function restoreGrant(
  caller: WsCaller,
  nodeId: string,
  wsId: string,
  confirm: boolean,
): Promise<GrantsWriteResponse> {
  return change(
    caller,
    nodeId,
    { folderConfirm: true, confirm },
    async (_q, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row?.excluded) {
        throw new GrantError(409, 'not_excluded', 'The item is not removed from that workspace.');
      }
      if (!mayManage(ctx, item) || !isMod(ctx, row.ws)) {
        throw new GrantError(
          403,
          'forbidden',
          'Only a Moderator of the item’s home who also moderates that workspace can restore it.',
        );
      }
      return row;
    },
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, _grants, row) => {
      // The delete re-derives the item from its folder (0241 propagation).
      await grantChange(tx, 'restore', item.id, row.ws, false, ctx.caller.loginId);
      await event(tx, row.ws, ctx.caller.loginId, 'grant.restore', { node: item.id });
    },
  );
}

/** POST /api/grants/:nodeId/:wsId/hand ("Change here"): a folder-derived
 *  row becomes a grant set on the item; it then stays when the folder's
 *  grant changes. Nobody gains or loses access. */
export async function handGrant(
  caller: WsCaller,
  nodeId: string,
  wsId: string,
): Promise<GrantsWriteResponse> {
  return change(
    caller,
    nodeId,
    // A folder's row changing from derived to hand reaches its subtree: the
    // size limit holds (audit L1), no confirm (nobody gains or loses).
    { folderConfirm: false, confirm: true },
    async (_q, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row || row.excluded || !row.via) {
        throw new GrantError(409, 'not_derived', 'This grant does not come from a folder.');
      }
      if (!mayManage(ctx, item) || !isMod(ctx, row.ws)) {
        throw new GrantError(
          403,
          'forbidden',
          'Only a Moderator of the item’s home who also moderates that workspace can change it here.',
        );
      }
      return row;
    },
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, _grants, row) => {
      await grantChange(tx, 'hand', item.id, row.ws, row.write, ctx.caller.loginId);
      await event(tx, row.ws, ctx.caller.loginId, 'grant.hand', {
        node: item.id,
        folder: row.via,
      });
    },
  );
}

/** POST /api/grants/:nodeId/embeds ("Grant these too"): the embeds the
 *  panel lists, granted to `wsIds` (each must hold the item). Pairs the
 *  caller may not grant are skipped and said. */
export async function grantEmbeds(
  caller: WsCaller,
  nodeId: string,
  body: { wsIds: string[]; confirm?: boolean },
): Promise<GrantsWriteResponse & { skipped: GrantEmbedSkip[] }> {
  const ctx0 = await loadCtx(caller);
  const host0 = await loadItem(ctx0, nodeId);
  if (!EMBEDDING_KINDS.includes(host0.type)) {
    throw new GrantError(400, 'invalid', 'Only pages, drawings and notes embed items.');
  }
  const checkTargets = async (ctx: Ctx, host: Item, q: Exec): Promise<string[]> => {
    const out: string[] = [];
    for (const raw of new Set(body.wsIds)) {
      const t = await seeTarget(ctx, raw, q);
      if (!host.readWs.includes(t.wsId)) {
        throw new GrantError(
          400,
          'invalid',
          `${t.name}: the item itself is not in that workspace.`,
        );
      }
      out.push(t.wsId);
    }
    return out;
  };
  const targets = await checkTargets(ctx0, host0, db);
  const embeds0 = await embedRows(ctx0, host0, db);
  const skipped: GrantEmbedSkip[] = [];
  if (embeds0.length && targets.length) {
    const ids = embeds0.map((e) => e.id);
    try {
      await withDeadlockRetry(() =>
        withHeads(ids, 'update', async (tx) => {
          skipped.length = 0;
          const ctx = await loadCtx(caller, tx);
          const host = await loadItem(ctx, host0.id, tx);
          // The targets again under the heads (audit L3): the host may have
          // left a workspace, or the caller a workspace, since the first read.
          const targetsNow = await checkTargets(ctx, host, tx);
          const now = await embedRows(ctx, host, tx);
          // An embed added since the first read: its head too, without
          // waiting (a busy one retries the whole transaction).
          const known = new Set(ids);
          await lockMoreHeads(
            tx,
            now.map((e) => e.id).filter((id) => !known.has(id)),
          );
          for (const e of now) {
            const embed = await loadItem(ctx, e.id, tx);
            const grants = await grantRows(tx, embed.id);
            for (const ws of targetsNow) {
              const row = grants.get(ws);
              if (row && !row.excluded) continue;
              const skip = (code: GrantErrorCode) =>
                skipped.push({ nodeId: embed.id, wsId: ws, code });
              if (!mayManage(ctx, embed) || !isMod(ctx, ws)) {
                skip('forbidden');
                continue;
              }
              if (!(await kindOk(tx, embed.type, ws))) {
                skip('kind_not_allowed');
                continue;
              }
              if (embed.type === 'app' && body.confirm !== true) {
                skip('confirm_required');
                continue;
              }
              await grantChange(tx, 'add', embed.id, ws, false, ctx.caller.loginId);
              await event(tx, ws, ctx.caller.loginId, 'grant.add', {
                node: embed.id,
                write: false,
                embedOf: host.id,
              });
            }
          }
        }),
      );
    } catch (err) {
      throw dbRefusal(err) ?? err;
    }
  }
  await refoldAfter(
    caller.anchorId,
    embeds0.map((e) => ({ id: e.id, type: e.type, path: null })),
  );
  const panel = await after(caller, host0.id);
  return { ...panel, skipped };
}

// ── Preview (S5, S7) ─────────────────────────────────────────────────────────

/** How many items (the item, and for a folder everything in it) would gain
 *  `ws` if it were granted to the item. An exclusion inside the folder stops
 *  the folder's grant below it; an item already granted gains nothing. */
async function gainCount(
  q: Exec,
  anchorId: string,
  item: Item,
  ws: string,
): Promise<{ n: number; apps: number }> {
  const [r] = await rows<{ n: number; apps: number }>(
    q,
    sql`with x as (select id, owner_id, path, type from nodes where id = ${item.id}),
        sub as (
          select n.id, n.type, n.path from nodes n, x
           where n.owner_id = ${anchorId}
             and (n.id = x.id or (x.type = 'branch' and n.path <@ x.path)))
        select count(*)::int as n, (count(*) filter (where d.type = 'app'))::int as apps
          from sub d, x
         where not exists (select 1 from item_grants g
                            where g.node_id = d.id and g.workspace_id = ${ws} and not g.excluded)
           and (d.id = x.id or (
                 not exists (select 1 from item_grants g
                              where g.node_id = d.id and g.workspace_id = ${ws})
                 and mantle_grant_kind_ok(d.type, ${ws}::uuid, true)
                 and not exists (
                   select 1 from nodes a
                     join item_grants ag on ag.node_id = a.id and ag.workspace_id = ${ws}
                                        and ag.excluded
                    where a.owner_id = x.owner_id and a.type = 'branch' and a.path <@ x.path
                      and a.id <> x.id and a.id <> d.id and d.path <@ a.path)))`,
  );
  return { n: r?.n ?? 0, apps: r?.apps ?? 0 };
}

/** Items in the folder the caller cannot open (0 for an item: the caller
 *  reads it). The counts stay honest; the panel says some are hidden. */
async function hiddenCount(q: Exec, ctx: Ctx, item: Item): Promise<number> {
  if (item.type !== 'branch' || !item.path) return 0;
  const [r] = await rows<{ n: number }>(
    q,
    sql`select count(*)::int as n from nodes
         where owner_id = ${ctx.caller.anchorId} and path <@ ${item.path}::ltree
           and not (read_ws && ${uuidList(myIds(ctx))}::uuid[])`,
  );
  return r?.n ?? 0;
}

/** How many items would lose `ws` if it were removed from the item: the
 *  item, and the folder-derived rows below it up to the first folder that
 *  holds `ws` by a grant set on it. */
async function loseCount(q: Exec, anchorId: string, item: Item, ws: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    q,
    sql`with x as (select id, owner_id, path, type from nodes where id = ${item.id}),
        sub as (
          select n.id, n.type, n.path from nodes n, x
           where n.owner_id = ${anchorId}
             and (n.id = x.id or (x.type = 'branch' and n.path <@ x.path)))
        select count(*)::int as n from sub d, x
         where exists (select 1 from item_grants g
                        where g.node_id = d.id and g.workspace_id = ${ws} and not g.excluded
                          and ((d.id = x.id and not g.is_home)
                               or (d.id <> x.id and g.via_folder_id is not null)))
           and (d.id = x.id or not exists (
                 select 1 from nodes a
                   join item_grants ag on ag.node_id = a.id and ag.workspace_id = ${ws}
                                      and not ag.excluded and ag.via_folder_id is null
                  where a.owner_id = x.owner_id and a.type = 'branch' and a.path <@ x.path
                    and a.id <> x.id and a.id <> d.id and d.path <@ a.path))`,
  );
  return r?.n ?? 0;
}

/** GET /api/grants/:nodeId/preview?add=<ws>&remove=<ws>. */
export async function previewGrant(
  caller: WsCaller,
  nodeId: string,
  add: string | null,
  remove: string | null,
): Promise<GrantPreviewResponse> {
  const ctx = await loadCtx(caller);
  const item = await loadItem(ctx, nodeId);
  const addWs = add ? (await seeTarget(ctx, add)).wsId : null;
  const removeWs = remove ? (await seeTarget(ctx, remove)).wsId : null;
  if (!addWs && !removeWs) {
    throw new GrantError(400, 'invalid', 'Name a workspace to add or to remove.');
  }
  // The change's own rules (audit M2): add = home Moderator AND Moderator
  // of the target; remove = either.
  const manage = mayManage(ctx, item);
  if (
    (addWs && !(manage && isMod(ctx, addWs))) ||
    (removeWs && !(manage || isMod(ctx, removeWs)))
  ) {
    throw new GrantError(403, 'forbidden', 'Only a Moderator can preview this change.');
  }
  const anchor = caller.anchorId;
  const total = await subtreeCount(db, anchor, item);
  const gain = addWs ? await gainCount(db, anchor, item, addWs) : { n: 0, apps: 0 };
  const out: GrantPreviewResponse = {
    gain: gain.n,
    gainApps: gain.apps,
    lose: removeWs ? await loseCount(db, anchor, item, removeWs) : 0,
    total,
    hidden: await hiddenCount(db, ctx, item),
    tooBig: item.type === 'branch' && total > FOLDER_GRANT_LIMIT.max,
  };
  if (item.type === 'app' && addWs) {
    const [x] = await rows<{ n: number }>(
      db,
      sql`select count(*)::int as n from app_table_exports where app_node_id = ${item.id}`,
    );
    let rowCount: number | null;
    try {
      const { tables } = await appDbTableDetails(anchor, item.id);
      rowCount = tables.length ? tables.reduce((s, t) => s + (t.rowCount ?? 0), 0) : null;
    } catch {
      rowCount = null;
    }
    out.app = { rows: rowCount, exportedTables: x?.n ?? 0 };
  }
  return out;
}

// ── Move (decision 4, S6, 18.8, 21.8 rows 1 and 9) ──────────────────────────

/** The body of a move and of its preview. */
export const MoveBody = z.object({
  nodeIds: z.array(z.string().uuid()).min(1).max(200),
  toWorkspaceId: z.string().uuid().optional(),
  toFolderId: z.string().uuid().nullable().optional(),
  keepReadableIn: z.string().uuid().optional(),
  confirm: z.boolean().optional(),
});

export type MoveInput = {
  nodeIds: string[];
  toWorkspaceId?: string;
  toFolderId?: string | null;
  keepReadableIn?: string;
  confirm?: boolean;
};

function moveTarget(body: MoveInput): 'workspace' | 'folder' {
  const ws = body.toWorkspaceId !== undefined;
  const folder = body.toFolderId !== undefined;
  if (ws === folder) {
    throw new GrantError(400, 'invalid', 'Name either toWorkspaceId or toFolderId.');
  }
  if (folder && body.keepReadableIn !== undefined) {
    throw new GrantError(400, 'invalid', 'keepReadableIn goes with toWorkspaceId.');
  }
  return ws ? 'workspace' : 'folder';
}

/** The tree kind an item lives in, from its path's root label. */
function treeKindOf(path: string | null): TreeKind | null {
  const root = (path ?? '').split('.')[0];
  for (const spec of Object.values(TREE_KIND_SPECS)) if (spec.root === root) return spec.kind;
  return null;
}

const nameOf = async (ctx: Ctx, ids: Iterable<string>): Promise<GrantWorkspaceRef[]> => {
  const list = [...new Set(ids)];
  if (!list.length) return [];
  const named = await rows<{ id: string; name: string }>(
    db,
    sql`select id, name from workspaces
         where id = any(${uuidList(list)}::uuid[]) and owner_id = ${ctx.caller.anchorId}
         order by lower(name), id`,
  );
  return named.map((w) => ({ wsId: w.id, name: w.name }));
};

/** The move to a workspace, checked by its own rules first (audit M3):
 *  Moderator of the target and of every item's home. Then what each item
 *  would gain and lose: only the target and the old homes, all workspaces
 *  the caller moderates. */
async function planWorkspaceMove(ctx: Ctx, body: MoveInput, q: Exec) {
  const t = await seeTarget(ctx, body.toWorkspaceId!, q);
  if (!isMod(ctx, t.wsId)) {
    throw new GrantError(
      403,
      'forbidden',
      'Only a Moderator of that workspace can move items into it.',
    );
  }
  const items: Item[] = [];
  for (const id of new Set(body.nodeIds)) {
    const item = await loadItem(ctx, id, q);
    if (!mayManage(ctx, item)) {
      throw new GrantError(403, 'forbidden', 'Only a Moderator of the item’s home can move it.');
    }
    items.push(item);
  }
  const gain = new Set<string>();
  const lose = new Set<string>();
  for (const item of items) {
    if (!item.readWs.includes(t.wsId)) gain.add(t.wsId);
    if (item.home && item.home !== t.wsId && body.keepReadableIn !== item.home) {
      if (!(await folderGrants(q, item, item.home))) lose.add(item.home);
    }
  }
  return { gain, lose };
}

/** The workspaces a folder passes on (its rows not removed there); none at
 *  a kind's root. */
async function folderWorkspaces(q: Exec, folder: Item | null): Promise<string[]> {
  if (!folder) return [];
  return (
    await rows<{ ws: string }>(
      q,
      sql`select workspace_id as ws from item_grants
           where node_id = ${folder.id} and not excluded`,
    )
  ).map((r) => r.ws);
}

/** What one item gains and loses by being placed in a folder that passes
 *  `folderWs` (S6): it takes those rows (not where it is "Removed here", and
 *  only kinds that may take them), and drops its folder-derived rows the new
 *  folder does not give, unless a grant set on it keeps that workspace. */
async function placeInFolder(
  q: Exec,
  item: Item,
  folderWs: string[],
): Promise<{ adds: string[]; loses: string[] }> {
  const grants = await grantRows(q, item.id);
  const kept = new Set([...grants.values()].filter((g) => !g.excluded && !g.via).map((g) => g.ws));
  const blocked = new Set([...grants.values()].filter((g) => g.excluded).map((g) => g.ws));
  const okRows = folderWs.length
    ? await rows<{ id: string }>(
        q,
        sql`select x.id from unnest(${uuidList(folderWs)}::uuid[]) as x(id)
             where mantle_grant_kind_ok(${item.type}::node_type, x.id, true)`,
      )
    : [];
  const takes = new Set(okRows.map((r) => r.id).filter((w) => !blocked.has(w)));
  const adds = [...takes].filter((w) => !item.readWs.includes(w));
  const loses = [...grants.values()]
    .filter((g) => !g.excluded && g.via && !takes.has(g.ws) && !kept.has(g.ws))
    .map((g) => g.ws);
  return { adds, loses };
}

/** The folder a move targets: one the caller may add items to (S6), of the
 *  items' tree kind; null = the kind's root. */
async function targetFolder(
  ctx: Ctx,
  folderId: string | null | undefined,
  kind: TreeKind,
  q: Exec,
): Promise<Item | null> {
  if (!folderId) return null;
  const folder = await loadItem(ctx, folderId, q).catch(() => {
    throw new GrantError(404, 'not_found', 'Folder not found.');
  });
  if (folder.type !== 'branch' || treeKindOf(folder.path) !== kind) {
    throw new GrantError(404, 'not_found', 'Folder not found.');
  }
  if (!mayEdit(ctx, folder)) {
    throw new GrantError(403, 'forbidden', 'You may not add items to that folder.');
  }
  return folder;
}

/** An app placed where it gains a holder the caller does not moderate. */
const APP_HOLDER = () =>
  new GrantError(403, 'forbidden', 'Placing this app there adds a workspace you do not moderate.');

/** The move into a folder, checked: S6 (edit the folder, manage the item),
 *  apps need Moderator of every new holder (18.8). `strict` (the preview)
 *  refuses the whole move on any item that may not go; the move itself
 *  reports such items one by one. */
async function planFolderMove(ctx: Ctx, body: MoveInput, q: Exec, strict: boolean) {
  const items: Item[] = [];
  for (const id of new Set(body.nodeIds)) items.push(await loadItem(ctx, id, q));
  if (items.some((i) => i.type === 'branch')) {
    throw new GrantError(400, 'invalid', 'Folders move with the tree’s folder route.');
  }
  const kinds = new Set(items.map((i) => treeKindOf(i.path)));
  if (kinds.size !== 1 || kinds.has(null)) {
    throw new GrantError(409, 'mixed_kinds', 'Move items of one kind at a time.');
  }
  const kind = [...kinds][0]!;
  const folder = await targetFolder(ctx, body.toFolderId, kind, q);
  const folderWs = await folderWorkspaces(q, folder);
  const gain = new Set<string>();
  const lose = new Set<string>();
  const perItem: Array<{ item: Item; adds: string[]; refusal: GrantError | null }> = [];
  for (const item of items) {
    const { adds, loses } = await placeInFolder(q, item, folderWs);
    const refusal = !mayManage(ctx, item)
      ? NOT_MANAGER()
      : item.type === 'app' && adds.some((w) => !isMod(ctx, w))
        ? APP_HOLDER()
        : null;
    if (refusal && strict) throw refusal;
    if (refusal) {
      perItem.push({ item, adds, refusal });
      continue;
    }
    for (const w of adds) gain.add(w);
    for (const w of loses) lose.add(w);
    perItem.push({ item, adds, refusal: null });
  }
  return { kind, folder, gain, lose, perItem };
}

/** POST /api/grants/move/preview. */
export async function previewMove(
  caller: WsCaller,
  body: MoveInput,
): Promise<GrantMovePreviewResponse> {
  const ctx = await loadCtx(caller);
  const plan =
    moveTarget(body) === 'workspace'
      ? await planWorkspaceMove(ctx, body, db)
      : await planFolderMove(ctx, body, db, true);
  return { alsoVisibleTo: await nameOf(ctx, plan.gain), removedFrom: await nameOf(ctx, plan.lose) };
}

/** POST /api/grants/move. Each item moves on its own; one that cannot is
 *  reported in `failed`, the rest still move. */
export async function moveItems(caller: WsCaller, body: MoveInput): Promise<GrantMoveResponse> {
  const ctx = await loadCtx(caller);
  if (moveTarget(body) === 'folder') return moveToFolder(ctx, body);
  const t = await seeTarget(ctx, body.toWorkspaceId!);
  if (!isMod(ctx, t.wsId)) {
    throw new GrantError(
      403,
      'forbidden',
      'Only a Moderator of that workspace can move items into it.',
    );
  }
  const result: GrantMoveResponse = { moved: 0, failed: [] };
  for (const raw of new Set(body.nodeIds)) {
    try {
      await moveHome(ctx.caller, raw, t.wsId, body);
      result.moved += 1;
    } catch (err) {
      const e = err instanceof GrantError ? err : dbRefusal(err);
      if (!e) throw err;
      result.failed.push({ id: raw, error: e.message });
    }
  }
  return result;
}

/** One item's home from H to T (18.8): T's row becomes the home (a
 *  folder-derived one stops being derived: CHECK item_grants_home_not_
 *  derived_ck, and the old folder is logged); H's row goes, unless the
 *  caller keeps it readable there (a grant set on the item, Write off) or a
 *  folder still gives H (it comes back as that folder's row). */
async function moveHome(caller: WsCaller, nodeId: string, to: string, body: MoveInput) {
  await change(
    caller,
    nodeId,
    { folderConfirm: true, appConfirm: true, confirm: body.confirm === true },
    async (q, ctx, item, _grants) => {
      if (!mayManage(ctx, item)) {
        throw new GrantError(403, 'forbidden', 'Only a Moderator of the item’s home can move it.');
      }
      if (!isMod(ctx, to)) {
        throw new GrantError(
          403,
          'forbidden',
          'Only a Moderator of that workspace can move items into it.',
        );
      }
      const from = item.home!;
      if (from === to) throw new GrantError(409, 'same_home', 'The item already lives there.');
      if (body.keepReadableIn !== undefined && body.keepReadableIn.toLowerCase() !== from) {
        throw new GrantError(400, 'invalid', 'keepReadableIn: only the old home can be kept.');
      }
      if (!(await kindOk(q, item.type, to))) {
        throw new GrantError(
          409,
          'kind_not_allowed',
          'This kind of item lives in the Admin workspace only.',
        );
      }
      return from;
    },
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, grants, from) => {
      const keep = body.keepReadableIn !== undefined;
      const target = grants.get(to);
      // One step (0279, mantle_grant_move_home): the old home row cleared,
      // the new one set, the old one kept with Write off or gone (a folder
      // that still gives it brings it back as its row). Never one UPDATE of
      // both rows: the one-home index is not deferrable (23505 by row order).
      await tx.execute(
        sql`select mantle_grant_move_home(${item.id}::uuid, ${to}::uuid, ${keep},
                                          ${ctx.caller.loginId}::uuid)`,
      );
      const viaFolder = target && !target.excluded ? target.via : null;
      await event(tx, to, ctx.caller.loginId, 'grant.move', {
        node: item.id,
        from,
        to,
        ...(viaFolder ? { viaFolder } : {}),
      });
      await event(tx, from, ctx.caller.loginId, 'grant.move', {
        node: item.id,
        from,
        to,
        kept: keep,
      });
    },
  );
}

/** Items into a folder (or the kind's root): checked by S6, then moved by
 *  the tree's own move (heads, paths, files on disk), whose triggers derive
 *  the folder's grants. Each item's move checks the plan again under its
 *  heads (the item and both folders, audit L3): the folder's workspaces,
 *  the app holder rule and the confirm, as they are now. */
async function moveToFolder(ctx: Ctx, body: MoveInput): Promise<GrantMoveResponse> {
  const plan = await planFolderMove(ctx, body, db, false);
  const result: GrantMoveResponse = { moved: 0, failed: [] };
  const go: string[] = [];
  for (const { item, refusal } of plan.perItem) {
    if (refusal) result.failed.push({ id: item.id, error: refusal.message });
    else go.push(item.id);
  }
  if (go.length && (plan.gain.size || plan.lose.size) && body.confirm !== true) {
    throw new GrantError(
      409,
      'confirm_required',
      'This move changes who can see the items. Confirm to go ahead.',
    );
  }
  if (!go.length) return result;
  const guard = async (tx: Exec, itemId: string) => {
    const now = await loadCtx(ctx.caller, tx);
    const item = await loadItem(now, itemId, tx);
    if (!mayManage(now, item)) throw NOT_MANAGER();
    const folder = await targetFolder(now, body.toFolderId, plan.kind, tx);
    const { adds, loses } = await placeInFolder(tx, item, await folderWorkspaces(tx, folder));
    if (item.type === 'app' && adds.some((w) => !isMod(now, w))) throw APP_HOLDER();
    // The confirm covers what the caller was shown (the plan's gain and
    // lose): a change under the heads that reaches further asks again.
    const beyond = adds.some((w) => !plan.gain.has(w)) || loses.some((w) => !plan.lose.has(w));
    if ((adds.length || loses.length) && (body.confirm !== true || beyond)) {
      throw new GrantError(
        409,
        'confirm_required',
        'This move now changes who can see the item. Confirm to go ahead.',
      );
    }
  };
  try {
    const moved = await moveTreeItems(ctx.caller.anchorId, plan.kind, go, plan.folder?.id ?? null, {
      confirm: true,
      guard,
    });
    if (moved.moved) {
      await notifyTreeChanged(ctx.caller.anchorId, plan.kind);
      const failed = new Set(moved.failed.map((f) => f.id));
      await refoldAfter(
        ctx.caller.anchorId,
        plan.perItem.filter((p) => !p.refusal && !failed.has(p.item.id)).map((p) => p.item),
      );
    }
    result.moved = moved.moved;
    result.failed.push(...moved.failed);
  } catch (err) {
    result.failed.push(...go.map((id) => ({ id, error: publicErrorMessage(err, 'grants move') })));
  }
  return result;
}
