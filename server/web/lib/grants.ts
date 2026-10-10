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
 * While the level bridge runs (0251), the rows it owns (the Admin and Team
 * rows of items made in today's UI) answer 409 bridge_owned: a change there
 * would be undone at the next level change or by the boot drift repair.
 * Grants to any other workspace are free.
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
} from '@mantle/content';
import { appDbTableDetails } from '@mantle/content/app-broker';
import { moveTreeItems, notifyTreeChanged } from '@mantle/content/tree';
import { publicErrorMessage } from '@mantle/std';
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
const BRIDGE_OWNED = () =>
  new GrantError(
    409,
    'bridge_owned',
    'This grant follows the item’s sharing level until grants become the truth. Change the level instead.',
  );

/** A folder change is refused above `max` items (S5: the measured
 *  50,000-item folder change stays well under a minute). An object so a
 *  test can lower it. */
export const FOLDER_GRANT_LIMIT = { max: 50_000 };

/** Run a grants route: resolve the caller, answer the result as JSON or a
 *  refusal as `{ error, code }`. Anything else throws (opaque 500). */
export async function grantsRoute(
  fn: (caller: WsCaller) => Promise<unknown>,
  okStatus = 200,
): Promise<Response> {
  const caller = await workspaceCaller();
  if (caller instanceof Response) return caller;
  try {
    return NextResponse.json(await fn(caller), { status: okStatus });
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
  bridge: boolean;
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
    bridge: boolean;
  }>(
    q,
    sql`select g.workspace_id as ws, w.name, g.write, g.is_home, g.via_folder_id as via,
               g.excluded, g.bridge
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
        bridge: r.bridge,
      },
    ]),
  );
}

/** The item is decided by the level bridge: its home row is a bridge row. */
function bridgeHomed(grants: Map<string, GrantDbRow>): boolean {
  for (const g of grants.values()) if (g.isHome && g.bridge) return true;
  return false;
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
  await q.execute(
    sql`insert into workspace_events (workspace_id, actor_id, action, subject)
        values (${ws}, ${actor}, ${action}, ${JSON.stringify(subject)}::jsonb)`,
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
    bridge: boolean;
    derivable: boolean;
  }>(
    q,
    sql`select g.workspace_id as ws, w.name, g.write, g.is_home, g.via_folder_id as via,
               f.title as via_title, (f.read_ws && ${mine}::uuid[]) as via_readable,
               g.excluded, g.bridge,
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
  const bridged = list.some((r) => r.is_home && r.bridge);
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
      bridgeOwned: r.bridge && bridged,
    });
  }

  const homeRow = list.find((r) => r.is_home);
  const home = {
    wsId: item.home ?? '',
    name: homeRow && (ctx.mine.has(homeRow.ws) || ctx.seesAll) ? homeRow.name : null,
  };

  let addable: GrantWorkspaceRef[] = [];
  if (manage) {
    const taken = new Set(
      list.filter((r) => !r.excluded || (r.bridge && bridged)).map((r) => r.ws),
    );
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
    link: mayLink && share ? { id: share.id, path: `/s/${share.token}` } : null,
    contactShares,
    embedsNotGranted,
  };
  if (item.type === 'app') {
    const [a] = await rows<{ mcp: boolean }>(
      q,
      sql`select mcp_access as mcp from apps where node_id = ${item.id}`,
    );
    body.app = { mcpAccess: a?.mcp === true };
  }
  return body;
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
  /** A folder (or an app, see `appConfirm`) needs the confirm. */
  folderConfirm: boolean;
  /** An app also needs it (a new holder: S7). */
  appConfirm?: boolean;
  confirm: boolean;
};

/**
 * Run one change of `nodeId`'s grants: the caller and item read once to
 * answer 404/409 early; then, in ONE transaction whose first lock is the
 * heads (the item, or a folder's whole subtree), read again and `fn`
 * applied. Retried whole on a busy head or a deadlock.
 */
async function change(
  caller: WsCaller,
  nodeId: string,
  opts: Change,
  fn: (tx: Exec, ctx: Ctx, item: Item, grants: Map<string, GrantDbRow>) => Promise<void>,
): Promise<GrantsWriteResponse> {
  const ctx0 = await loadCtx(caller);
  const item0 = await loadItem(ctx0, nodeId);
  const folder = item0.type === 'branch';
  if (folder && opts.folderConfirm) {
    const total = await subtreeCount(db, caller.anchorId, item0);
    if (total > FOLDER_GRANT_LIMIT.max) {
      throw new GrantError(
        409,
        'too_big',
        `This folder holds ${total.toLocaleString('en')} items. Share its sub-folders one by one.`,
      );
    }
    if (!opts.confirm) {
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
    await fn(tx, ctx, item, await grantRows(tx, item.id));
  };
  try {
    await withDeadlockRetry(() =>
      folder ? withSubtreeHeads(item0.id, [], run) : withHeads([item0.id], 'update', run),
    );
  } catch (err) {
    throw dbRefusal(err) ?? err;
  }
  return after(caller, item0.id);
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
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).

    async (tx, ctx, item, grants) => {
      const t = await seeTarget(ctx, body.wsId, tx);
      if (!mayManage(ctx, item)) throw NOT_MANAGER();
      if (!isMod(ctx, t.wsId)) {
        throw new GrantError(
          403,
          'forbidden',
          'Only a Moderator of that workspace can add items to it.',
        );
      }
      const row = grants.get(t.wsId);
      if (row?.bridge && bridgeHomed(grants)) throw BRIDGE_OWNED();
      if (row && !row.excluded) {
        throw new GrantError(409, 'already_granted', 'The item is already in that workspace.');
      }
      if (!(await kindOk(tx, item.type, t.wsId))) {
        throw new GrantError(
          409,
          'kind_not_allowed',
          'This kind of item lives in the Admin workspace only.',
        );
      }
      const write = body.write === true;
      if (row) {
        await tx.execute(
          sql`update item_grants
                 set excluded = false, via_folder_id = null, write = ${write}, bridge = false,
                     granted_by = ${ctx.caller.loginId}, granted_at = now()
               where node_id = ${item.id} and workspace_id = ${t.wsId}`,
        );
      } else {
        await tx.execute(
          sql`insert into item_grants (node_id, workspace_id, write, granted_by)
              values (${item.id}, ${t.wsId}, ${write}, ${ctx.caller.loginId})`,
        );
      }
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
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).

    async (tx, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row || row.excluded) throw NOT_GRANTED();
      if (row.bridge && bridgeHomed(grants)) throw BRIDGE_OWNED();
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
      if (row.write === body.write) return;
      await tx.execute(
        sql`update item_grants set write = ${body.write}
             where node_id = ${item.id} and workspace_id = ${row.ws}`,
      );
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
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row || row.excluded) throw NOT_GRANTED();
      if (row.bridge && bridgeHomed(grants)) throw BRIDGE_OWNED();
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
      const exclude = row.via !== null || (await folderGrants(tx, item, row.ws));
      if (exclude) {
        await tx.execute(
          sql`update item_grants
               set excluded = true, write = false, via_folder_id = null, bridge = false,
                   granted_by = ${ctx.caller.loginId}, granted_at = now()
             where node_id = ${item.id} and workspace_id = ${row.ws}`,
        );
      } else {
        await tx.execute(
          sql`delete from item_grants where node_id = ${item.id} and workspace_id = ${row.ws}`,
        );
      }
      await event(tx, row.ws, ctx.caller.loginId, 'grant.remove', {
        node: item.id,
        excluded: exclude,
        ...(row.via ? { folder: row.via } : {}),
      });
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
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).
    async (tx, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row?.excluded) {
        throw new GrantError(409, 'not_excluded', 'The item is not removed from that workspace.');
      }
      if (row.bridge && bridgeHomed(grants)) throw BRIDGE_OWNED();
      if (!mayManage(ctx, item) || !isMod(ctx, row.ws)) {
        throw new GrantError(
          403,
          'forbidden',
          'Only a Moderator of the item’s home who also moderates that workspace can restore it.',
        );
      }
      // The delete re-derives the item from its folder (0241 propagation).
      await tx.execute(
        sql`delete from item_grants where node_id = ${item.id} and workspace_id = ${row.ws}`,
      );
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
    { folderConfirm: false, confirm: true },
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).

    async (tx, ctx, item, grants) => {
      const row = rowFor(ctx, item, grants, wsId);
      if (!row || row.excluded || !row.via) {
        throw new GrantError(409, 'not_derived', 'This grant does not come from a folder.');
      }
      if (row.bridge && bridgeHomed(grants)) throw BRIDGE_OWNED();
      if (!mayManage(ctx, item) || !isMod(ctx, row.ws)) {
        throw new GrantError(
          403,
          'forbidden',
          'Only a Moderator of the item’s home who also moderates that workspace can change it here.',
        );
      }
      await tx.execute(
        sql`update item_grants
               set via_folder_id = null, bridge = false,
                   granted_by = ${ctx.caller.loginId}, granted_at = now()
             where node_id = ${item.id} and workspace_id = ${row.ws}`,
      );
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
  const targets: string[] = [];
  for (const raw of new Set(body.wsIds)) {
    const t = await seeTarget(ctx0, raw);
    if (!host0.readWs.includes(t.wsId)) {
      throw new GrantError(400, 'invalid', `${t.name}: the item itself is not in that workspace.`);
    }
    targets.push(t.wsId);
  }
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
            for (const ws of targets) {
              const row = grants.get(ws);
              if (row && !row.excluded) continue;
              const skip = (code: GrantErrorCode) =>
                skipped.push({ nodeId: embed.id, wsId: ws, code });
              if (!mayManage(ctx, embed) || !isMod(ctx, ws)) {
                skip('forbidden');
                continue;
              }
              if (row?.bridge && bridgeHomed(grants)) {
                skip('bridge_owned');
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
              if (row) {
                await tx.execute(
                  sql`update item_grants
                         set excluded = false, via_folder_id = null, write = false, bridge = false,
                             granted_by = ${ctx.caller.loginId}, granted_at = now()
                       where node_id = ${embed.id} and workspace_id = ${ws}`,
                );
              } else {
                await tx.execute(
                  sql`insert into item_grants (node_id, workspace_id, write, granted_by)
                      values (${embed.id}, ${ws}, false, ${ctx.caller.loginId})`,
                );
              }
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
  const panel = await after(caller, host0.id);
  return { ...panel, skipped };
}

// ── Preview (S5, S7) ─────────────────────────────────────────────────────────

/** How many items (the item, and for a folder everything in it) would gain
 *  `ws` if it were granted to the item. An exclusion inside the folder stops
 *  the folder's grant below it; an item already granted gains nothing. */
async function gainCount(q: Exec, anchorId: string, item: Item, ws: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    q,
    sql`with x as (select id, owner_id, path, type from nodes where id = ${item.id}),
        sub as (
          select n.id, n.type, n.path from nodes n, x
           where n.owner_id = ${anchorId}
             and (n.id = x.id or (x.type = 'branch' and n.path <@ x.path)))
        select count(*)::int as n from sub d, x
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
  const named = [addWs, removeWs].filter((w): w is string => !!w);
  if (!mayManage(ctx, item) && !named.every((w) => isMod(ctx, w))) {
    throw new GrantError(403, 'forbidden', 'Only a Moderator can preview this change.');
  }
  const anchor = caller.anchorId;
  const total = await subtreeCount(db, anchor, item);
  const out: GrantPreviewResponse = {
    gain: addWs ? await gainCount(db, anchor, item, addWs) : 0,
    lose: removeWs ? await loseCount(db, anchor, item, removeWs) : 0,
    total,
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

/** The move to a workspace, checked: the items, the target, what each item
 *  would gain and lose. */
async function planWorkspaceMove(ctx: Ctx, body: MoveInput, q: Exec) {
  const t = await seeTarget(ctx, body.toWorkspaceId!, q);
  const items: Array<{ item: Item; grants: Map<string, GrantDbRow> }> = [];
  for (const id of new Set(body.nodeIds)) {
    const item = await loadItem(ctx, id, q);
    items.push({ item, grants: await grantRows(q, item.id) });
  }
  const gain = new Set<string>();
  const lose = new Set<string>();
  for (const { item } of items) {
    if (!item.readWs.includes(t.wsId)) gain.add(t.wsId);
    if (item.home && item.home !== t.wsId && body.keepReadableIn !== item.home) {
      if (!(await folderGrants(q, item, item.home))) lose.add(item.home);
    }
  }
  return { t, items, gain, lose };
}

/** The move into a folder, checked: S6 (edit the folder, manage the item),
 *  apps need Moderator of every new holder (18.8). */
async function planFolderMove(ctx: Ctx, body: MoveInput, q: Exec) {
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
  let folder: Item | null = null;
  let folderWs: string[] = [];
  if (body.toFolderId) {
    folder = await loadItem(ctx, body.toFolderId, q).catch(() => {
      throw new GrantError(404, 'not_found', 'Folder not found.');
    });
    if (folder.type !== 'branch' || treeKindOf(folder.path) !== kind) {
      throw new GrantError(404, 'not_found', 'Folder not found.');
    }
    if (!mayEdit(ctx, folder)) {
      throw new GrantError(403, 'forbidden', 'You may not add items to that folder.');
    }
    folderWs = (
      await rows<{ ws: string }>(
        q,
        sql`select workspace_id as ws from item_grants
             where node_id = ${folder.id} and not excluded`,
      )
    ).map((r) => r.ws);
  }
  const gain = new Set<string>();
  const lose = new Set<string>();
  const perItem: Array<{ item: Item; adds: string[] }> = [];
  for (const item of items) {
    const grants = await grantRows(q, item.id);
    const kept = new Set(
      [...grants.values()].filter((g) => !g.excluded && !g.via).map((g) => g.ws),
    );
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
    for (const w of adds) gain.add(w);
    for (const g of grants.values()) {
      if (!g.excluded && g.via && !takes.has(g.ws) && !kept.has(g.ws)) lose.add(g.ws);
    }
    perItem.push({ item, adds });
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
      : await planFolderMove(ctx, body, db);
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
    // @heads-held: change() runs this under the item's heads (a folder: its subtree).

    async (tx, ctx, item, grants) => {
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
      if (bridgeHomed(grants)) throw BRIDGE_OWNED();
      if (body.keepReadableIn !== undefined && body.keepReadableIn.toLowerCase() !== from) {
        throw new GrantError(400, 'invalid', 'keepReadableIn: only the old home can be kept.');
      }
      if (!(await kindOk(tx, item.type, to))) {
        throw new GrantError(
          409,
          'kind_not_allowed',
          'This kind of item lives in the Admin workspace only.',
        );
      }
      const keep = body.keepReadableIn !== undefined;
      const target = grants.get(to);
      await tx.execute(
        sql`update item_grants set is_home = false
             where node_id = ${item.id} and workspace_id = ${from}`,
      );
      if (target) {
        await tx.execute(
          sql`update item_grants
                 set is_home = true, via_folder_id = null, excluded = false, bridge = false,
                     write = ${target.excluded ? false : target.write},
                     granted_by = ${ctx.caller.loginId}, granted_at = now()
               where node_id = ${item.id} and workspace_id = ${to}`,
        );
      } else {
        await tx.execute(
          sql`insert into item_grants (node_id, workspace_id, write, is_home, granted_by)
              values (${item.id}, ${to}, false, true, ${ctx.caller.loginId})`,
        );
      }
      if (keep) {
        await tx.execute(
          sql`update item_grants set write = false, bridge = false
               where node_id = ${item.id} and workspace_id = ${from}`,
        );
      } else {
        // A folder that still gives the old home brings it back as its row.
        await tx.execute(
          sql`delete from item_grants where node_id = ${item.id} and workspace_id = ${from}`,
        );
      }
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
 *  the folder's grants. */
async function moveToFolder(ctx: Ctx, body: MoveInput): Promise<GrantMoveResponse> {
  const plan = await planFolderMove(ctx, body, db);
  const result: GrantMoveResponse = { moved: 0, failed: [] };
  const go: string[] = [];
  for (const { item, adds } of plan.perItem) {
    if (!mayManage(ctx, item)) {
      result.failed.push({ id: item.id, error: NOT_MANAGER().message });
      continue;
    }
    if (item.type === 'app' && adds.some((w) => !isMod(ctx, w))) {
      result.failed.push({
        id: item.id,
        error: 'Placing this app there adds a workspace you do not moderate.',
      });
      continue;
    }
    go.push(item.id);
  }
  if (go.length && (plan.gain.size || plan.lose.size) && body.confirm !== true) {
    throw new GrantError(
      409,
      'confirm_required',
      'This move changes who can see the items. Confirm to go ahead.',
    );
  }
  if (!go.length) return result;
  try {
    const moved = await moveTreeItems(ctx.caller.anchorId, plan.kind, go, plan.folder?.id ?? null, {
      confirm: true,
    });
    if (moved.moved) await notifyTreeChanged(ctx.caller.anchorId, plan.kind);
    result.moved = moved.moved;
    result.failed.push(...moved.failed);
  } catch (err) {
    result.failed.push(...go.map((id) => ({ id, error: publicErrorMessage(err, 'grants move') })));
  }
  return result;
}
