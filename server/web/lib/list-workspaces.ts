/**
 * The workspace chips and the `?ws=` filter of the brain's lists (W5b2
 * contract changes 5 and 14): every row of GET /api/pages and /api/notes,
 * and every item and folder of GET /api/tree/:kind (its search and marks
 * too), carries `workspaces` (the workspaces of its read_ws the caller is a
 * user of; all of them for an Admin user; live ones, by name, each with its
 * look: colour, icon and kind, task 5edc9149) and `hasLink`
 * (a live open public link exists). A list asked with `?ws=<id>` keeps only
 * what that workspace reads and echoes the id as a top-level `ws`.
 *
 * One place for every list (the apps list too), so the rule is the same
 * everywhere. A workspace the caller may not name is 404, never 403.
 *
 * Search across workspaces (task f26a516e): `parseReadCover` is the one
 * gateway that says what a read covers. A list narrows to the switcher's
 * workspace; a search (GET /api/search, and a tree search asked `across`)
 * covers every workspace the caller reads, and the switcher's workspace
 * only orders it. What the caller reads is never decided here: the reads
 * run in the caller's request scope, so the database's row rules keep out
 * every item of a workspace the caller is not in. `hitWorkspaces` names
 * where each hit opens, from the caller's own workspaces only.
 */
import {
  db,
  heldBySql,
  mayEditSql,
  mayManageSql,
  nodeAliasHomeIs,
  nodeAliasReadBy,
  sql,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import type { HitWorkspace, ItemCaps, ListChips, ListWorkspace } from '@mantle/client-types';
import type { TreeSearchCover } from '@mantle/content/tree';
import { NextResponse } from '@/server/http-compat';
import { WS_LOOK_PAIRS, workspaceLook } from '@/lib/workspace-look';
import { UUID_RE } from '@mantle/std';

/** No workspace and no link: a row the lookup did not find (a private row). */
const NONE: ListChips = { workspaces: [], hasLink: false, mayEdit: false, mayManage: false };

/**
 * The caps columns of `n` (W6b fix round 1, ItemCaps): in a workspace scope
 * the database's own rule (mantle_may_edit, mantle_may_manage); on the
 * system pool (the brain's owner, an Admin user under the rollback switch,
 * a brain not on workspaces) everything. Never edit for a read-only copy.
 */
function capsColumns() {
  const scoped = currentWorkspaceScope() !== null;
  const edit = scoped ? mayEditSql('n') : sql`true`;
  const manage = scoped ? mayManageSql('n') : sql`true`;
  return sql`(${edit} and not coalesce(n.data ? 'snapshot_of', false)) as may_edit,
             ${manage} as may_manage,
             nullif(n.data->>'snapshot_of', '') as snapshot_of,
             coalesce((n.data->>'trashedBeforeFold')::boolean, false) as trashed_before_fold`;
}

type CapsRow = {
  may_edit: boolean;
  may_manage: boolean;
  snapshot_of: string | null;
  trashed_before_fold: boolean;
};

function capsOf(r: CapsRow): ItemCaps {
  return {
    mayEdit: r.may_edit === true,
    mayManage: r.may_manage === true,
    ...(r.snapshot_of ? { readOnly: true as const, snapshotOf: r.snapshot_of } : {}),
    ...(r.trashed_before_fold === true ? { trashedBeforeFold: true as const } : {}),
  };
}

/** The caps of `nodeIds` for the caller, in one query (ids no row the
 *  caller reads has are left out). */
export async function itemCaps(nodeIds: readonly string[]): Promise<Map<string, ItemCaps>> {
  const ids = [...new Set(nodeIds.filter((id) => UUID_RE.test(id)))];
  const out = new Map<string, ItemCaps>();
  if (!ids.length) return out;
  const rows = (await db.execute(sql`
    select n.id::text as id, ${capsColumns()}
      from nodes n where n.id = any(${`{${ids.join(',')}}`}::uuid[])`)) as unknown as Array<
    CapsRow & { id: string }
  >;
  for (const r of rows) out.set(r.id, capsOf(r));
  return out;
}

const NO_CAPS: ItemCaps = { mayEdit: false, mayManage: false };

/** `rows` with their caps, read for the caller in one query. */
export async function capped<T extends { id: string }>(
  rows: readonly T[],
): Promise<Array<T & ItemCaps>> {
  const caps = await itemCaps(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, ...(caps.get(r.id) ?? NO_CAPS) }));
}

/** One item response with its caps. */
export async function cappedOne<T extends { id: string }>(row: T): Promise<T & ItemCaps> {
  return (await capped([row]))[0]!;
}

/** The caller's live workspaces (and whether one is Admin), as SQL. */
function mine(ownerId: string, loginId: string) {
  return sql`select w.id, w.is_admin from workspaces w
               join workspace_users u on u.workspace_id = w.id and u.login_id = ${loginId}
              where w.owner_id = ${ownerId} and w.archived_at is null`;
}

/**
 * The chips of `nodeIds` as `loginId` (a login of the brain `ownerId`) sees
 * them, in one query. Ids that name no node, or are not ids, get none.
 */
export async function workspaceChips(
  ownerId: string,
  loginId: string,
  nodeIds: readonly string[],
): Promise<Map<string, ListChips>> {
  const ids = [...new Set(nodeIds.filter((id) => UUID_RE.test(id)))];
  const out = new Map<string, ListChips>();
  if (!ids.length) return out;
  const rows = (await db.execute(sql`
    with me as (${mine(ownerId, loginId)})
    select n.id::text as id,
           coalesce((
             select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, ${WS_LOOK_PAIRS})
                              order by lower(w.name), w.id)
               from workspaces w
              where ${heldBySql('n', sql`w.id`)} and w.owner_id = ${ownerId} and w.archived_at is null
                and (exists (select 1 from me where me.is_admin)
                     or w.id in (select me.id from me))), '[]'::jsonb) as workspaces,
           exists (
             select 1 from shares s
              where s.node_id = n.id and s.revoked_at is null and s.contact_id is null
                and (s.expires_at is null or s.expires_at > now())
                and coalesce(s.settings->>'mode', 'public') <> 'team') as has_link,
           ${capsColumns()}
      from nodes n
     where n.id = any(${`{${ids.join(',')}}`}::uuid[])`)) as unknown as Array<
    CapsRow & {
      id: string;
      workspaces: ListWorkspace[];
      has_link: boolean;
    }
  >;
  for (const r of rows) {
    const workspaces = r.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      ...workspaceLook(w.color, w.icon, w.kind),
    }));
    out.set(r.id, { workspaces, hasLink: r.has_link === true, ...capsOf(r) });
  }
  return out;
}

/** `rows` with their chips, in place of whatever they carried. */
export function withChips<T extends { id: string }>(
  rows: readonly T[],
  chips: Map<string, ListChips>,
): Array<T & ListChips> {
  return rows.map((r) => ({ ...r, ...(chips.get(r.id) ?? NONE) }));
}

/** `rows` with their chips, read for the caller in one query. */
export async function chipped<T extends { id: string }>(
  ownerId: string,
  loginId: string,
  rows: readonly T[],
): Promise<Array<T & ListChips>> {
  return withChips(
    rows,
    await workspaceChips(
      ownerId,
      loginId,
      rows.map((r) => r.id),
    ),
  );
}

/**
 * `?ws=` of a list (and of the landing page, /api/home): null when not
 * asked; the workspace id when the caller is a user of it (a live workspace
 * of the brain), Admin users too: an Admin user joins a workspace first
 * (logged), then picks it; else a 404 to answer as is. The list form of
 * parseReadCover: it always narrows.
 */
export async function parseWsFilter(
  req: Request,
  ownerId: string,
  loginId: string,
): Promise<string | null | Response> {
  const cover = await parseReadCover(req, ownerId, loginId, 'list');
  return cover instanceof Response ? cover : cover.ws;
}

/**
 * What one read covers (task f26a516e): TreeSearchCover, the shape the
 * tree search takes as is.
 *  - `ws`: narrows the read to the items that workspace reads (a list);
 *    null narrows nothing.
 *  - `current`: the switcher's workspace, checked as `?ws=` always was
 *    (a workspace the caller is a user of; else 404); null when not asked.
 *  - `across`: the read covers every workspace the caller reads; `current`
 *    then only orders it (its own hits first).
 */
export type ReadCover = TreeSearchCover;

/**
 * How a route reads `?ws=`:
 *  - 'list': it narrows (every list, the landing page);
 *  - 'search': it narrows unless the request asks `across=1` with a term
 *    (a tree search; an empty term is the A to Z view, which narrows);
 *  - 'across': it never narrows (GET /api/search, which has always looked
 *    in every workspace the caller reads).
 */
export type ReadCoverMode = 'list' | 'search' | 'across';

/** The one place a route turns `?ws=` (and `across`, with the search term
 *  `q` in 'search' mode) into what its read covers; the reads take the
 *  answer as is and decide nothing again. The row rules of the caller's
 *  scope still decide what it reads. */
export async function parseReadCover(
  req: Request,
  ownerId: string,
  loginId: string,
  mode: ReadCoverMode,
  q = '',
): Promise<ReadCover | Response> {
  const params = new URL(req.url).searchParams;
  const asked = params.get('across');
  const across =
    mode === 'across' ||
    (mode === 'search' && (asked === '1' || asked === 'true') && q.trim() !== '');
  const raw = params.get('ws');
  if (raw === null) return { ws: null, current: null, across };
  const notFound = () =>
    NextResponse.json({ error: 'Workspace not found.', code: 'not_found' }, { status: 404 });
  if (!UUID_RE.test(raw)) return notFound();
  const ws = raw.toLowerCase();
  const [hit] = (await db.execute(sql`
    select 1 as ok from (${mine(ownerId, loginId)}) me where me.id = ${ws}::uuid`)) as unknown as Array<{
    ok: number;
  }>;
  if (!hit) return notFound();
  return { ws: across ? null : ws, current: ws, across };
}

/** The caller's own live workspaces other than `ws` (ids): where a
 *  folder's items elsewhere are counted (TreeFolder `itemsElsewhere`,
 *  TreeFolderPage `elsewhere`). Admin users too: only those they are in. */
export async function otherWorkspaces(
  ownerId: string,
  loginId: string,
  ws: string,
): Promise<string[]> {
  const rows = (await db.execute(sql`
    select me.id::text as id from (${mine(ownerId, loginId)}) me
     where me.id <> ${ws}::uuid`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Where each of `nodeIds` opens for `loginId` (HitWorkspace): a live
 * workspace the caller is a user of that reads the item, `current` first,
 * then the item's home, then by name. Read in the caller's scope, so an id
 * the caller does not read gets none; an Admin user gets only the
 * workspaces it is in (never one it would have to join first).
 */
export async function hitWorkspaces(
  ownerId: string,
  loginId: string,
  nodeIds: readonly string[],
  current: string | null,
): Promise<Map<string, HitWorkspace>> {
  const ids = [...new Set(nodeIds.filter((id) => UUID_RE.test(id)))];
  const out = new Map<string, HitWorkspace>();
  if (!ids.length) return out;
  const cur = current && UUID_RE.test(current) ? current : null;
  const rows = (await db.execute(sql`
    with me as (${mine(ownerId, loginId)})
    select n.id::text as id, w.id::text as ws_id, w.name
      from nodes n
      cross join lateral (
        select w.id, w.name from workspaces w
         where ${nodeAliasReadBy(sql`w.id`, 'n')} and w.id in (select me.id from me)
         order by (w.id = ${cur}::uuid) is true desc,
                  (${nodeAliasHomeIs(sql`w.id`, 'n')}) is true desc, lower(w.name), w.id
         limit 1) w
     where n.id = any(${`{${ids.join(',')}}`}::uuid[])`)) as unknown as Array<{
    id: string;
    ws_id: string;
    name: string;
  }>;
  for (const r of rows) out.set(r.id, { id: r.ws_id, name: r.name });
  return out;
}

/**
 * `rows` with the switcher's workspace's own first, in their order, then
 * the rest in theirs (a stable split; the search's ranking holds inside
 * each part). A row whose hit opens in `current` is its own. No `current`:
 * the rows as they are.
 */
export function currentFirst<T>(
  rows: readonly T[],
  hitOf: (row: T) => HitWorkspace | undefined,
  current: string | null,
): T[] {
  if (!current) return [...rows];
  const own = rows.filter((r) => hitOf(r)?.id === current);
  const rest = rows.filter((r) => hitOf(r)?.id !== current);
  return [...own, ...rest];
}
