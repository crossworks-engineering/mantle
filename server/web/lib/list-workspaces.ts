/**
 * The workspace chips of a list and its workspace filter (workspaces W5b2):
 * which workspaces hold each row (the item's read_ws), named only where the
 * caller may see the workspace, and `?ws=<id>` to keep the rows one
 * workspace holds. An Admin user sees every workspace; any other caller the
 * workspaces it is a user of. A workspace the caller may not see is 404
 * (`code: 'not_found'`), never 403. Archived workspaces show no chip.
 *
 * Owner routes, on the admin pool.
 */
import { NextResponse } from '@/server/http-compat';
import { db, sql } from '@mantle/db';
import { isUuid } from '@mantle/std';
import type { WorkspaceChip } from '@mantle/client-types';

async function isAdminUser(ownerId: string, loginId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1 from workspace_users u join workspaces w on w.id = u.workspace_id
     where w.owner_id = ${ownerId} and w.is_admin and u.login_id = ${loginId}
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** The chips of each row, by node id (a row no visible workspace holds
 *  maps to []). Sorted by name. */
export async function workspaceChips(
  ownerId: string,
  loginId: string,
  nodeIds: readonly string[],
): Promise<Map<string, WorkspaceChip[]>> {
  const out = new Map<string, WorkspaceChip[]>(nodeIds.map((id) => [id, []]));
  if (!nodeIds.length) return out;
  const admin = await isAdminUser(ownerId, loginId);
  const rows = (await db.execute(sql`
    select n.id::text as node_id, w.id::text as id, w.name
      from nodes n
      join workspaces w on w.id = any(n.read_ws) and w.owner_id = n.owner_id
     where n.owner_id = ${ownerId}
       and n.id = any(${`{${nodeIds.join(',')}}`}::uuid[])
       and w.archived_at is null
       and (${admin} or exists (
             select 1 from workspace_users u
              where u.workspace_id = w.id and u.login_id = ${loginId}))
     order by lower(w.name), w.name, w.id`)) as unknown as Array<{
    node_id: string;
    id: string;
    name: string;
  }>;
  for (const r of rows) out.get(r.node_id)?.push({ id: r.id, name: r.name });
  return out;
}

/** `?ws=<id>`: the workspace to filter by (null when absent), or a 404 when
 *  the caller may not see it (not a uuid, not this brain's, or not a user of
 *  it and not an Admin user). */
export async function parseWsFilter(
  url: URL,
  ownerId: string,
  loginId: string,
): Promise<{ ws: string | null } | Response> {
  const raw = url.searchParams.get('ws');
  if (raw === null || raw.trim() === '') return { ws: null };
  const notFound = NextResponse.json(
    { error: 'workspace not found', code: 'not_found' },
    { status: 404 },
  );
  const ws = raw.trim().toLowerCase();
  if (!isUuid(ws)) return notFound;
  const rows = (await db.execute(sql`
    select 1 from workspaces w
     where w.id = ${ws} and w.owner_id = ${ownerId}
       and (exists (select 1 from workspace_users u
                     where u.workspace_id = w.id and u.login_id = ${loginId})
            or exists (select 1 from workspace_users u join workspaces a on a.id = u.workspace_id
                        where a.owner_id = ${ownerId} and a.is_admin and u.login_id = ${loginId}))
     limit 1`)) as unknown as unknown[];
  return rows.length ? { ws } : notFound;
}
