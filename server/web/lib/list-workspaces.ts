/**
 * The workspace chips and the `?ws=` filter of the brain's lists (W5b2
 * contract changes 5 and 14): every row of GET /api/pages and /api/notes,
 * and every item and folder of GET /api/tree/:kind (its search and marks
 * too), carries `workspaces` (the workspaces of its read_ws the caller is a
 * user of; all of them for an Admin user; live ones, by name) and `hasLink`
 * (a live open public link exists). A list asked with `?ws=<id>` keeps only
 * what that workspace reads and echoes the id as a top-level `ws`.
 *
 * One place for every list (the apps list too), so the rule is the same
 * everywhere. A workspace the caller may not name is 404, never 403.
 */
import { db, sql } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import type { ItemCaps, ListChips, ListWorkspace } from '@mantle/client-types';
import { NextResponse } from '@/server/http-compat';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const edit = scoped
    ? sql`coalesce("public"."mantle_may_edit"(n.home_ws, n.write_ws), false)`
    : sql`true`;
  const manage = scoped ? sql`coalesce("public"."mantle_may_manage"(n.home_ws), false)` : sql`true`;
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
             select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name)
                              order by lower(w.name), w.id)
               from workspaces w
              where w.id = any(n.read_ws) and w.owner_id = ${ownerId} and w.archived_at is null
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
    out.set(r.id, { workspaces: r.workspaces, hasLink: r.has_link === true, ...capsOf(r) });
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
 * (logged), then picks it; else a 404 to answer as is.
 */
export async function parseWsFilter(
  req: Request,
  ownerId: string,
  loginId: string,
): Promise<string | null | Response> {
  const raw = new URL(req.url).searchParams.get('ws');
  if (raw === null) return null;
  const notFound = () =>
    NextResponse.json({ error: 'Workspace not found.', code: 'not_found' }, { status: 404 });
  if (!UUID_RE.test(raw)) return notFound();
  const ws = raw.toLowerCase();
  const [hit] = (await db.execute(sql`
    select 1 as ok from (${mine(ownerId, loginId)}) me where me.id = ${ws}::uuid`)) as unknown as Array<{
    ok: number;
  }>;
  return hit ? ws : notFound();
}
