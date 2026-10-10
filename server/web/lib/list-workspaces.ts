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
import type { ListChips, ListWorkspace } from '@mantle/client-types';
import { NextResponse } from '@/server/http-compat';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No workspace and no link: a row the lookup did not find (a private row). */
const NONE: ListChips = { workspaces: [], hasLink: false };

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
                and coalesce(s.settings->>'mode', 'public') <> 'team') as has_link
      from nodes n
     where n.id = any(${`{${ids.join(',')}}`}::uuid[])`)) as unknown as Array<{
    id: string;
    workspaces: ListWorkspace[];
    has_link: boolean;
  }>;
  for (const r of rows) out.set(r.id, { workspaces: r.workspaces, hasLink: r.has_link === true });
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
 * `?ws=` of a list: null when not asked; the workspace id when the caller
 * may name it (a user of it, or an Admin user; a live workspace of the
 * brain); else a 404 to answer as is.
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
    with me as (${mine(ownerId, loginId)})
    select 1 as ok from workspaces w
     where w.id = ${ws}::uuid and w.owner_id = ${ownerId} and w.archived_at is null
       and (exists (select 1 from me where me.is_admin) or w.id in (select me.id from me))`)) as unknown as Array<{
    ok: number;
  }>;
  return hit ? ws : notFound();
}
