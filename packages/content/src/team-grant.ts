/**
 * The Team workspace (bridge_key 'team') and the items it reads, for the two
 * writers that still name a level after workspaces W5b2: an Accept into the
 * brain (contract change 22) and the members' home app. Grants are the one
 * truth of who reads an item; nothing here touches a level column.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

type Exec = Pick<typeof db, 'execute'>;

/** Whether the brain's Team workspace reads the item (it is in read_ws).
 *  False on a brain with no Team workspace. */
export async function teamReadsItem(ownerId: string, nodeId: string): Promise<boolean> {
  const [row] = (await db.execute(sql`
    select exists (
      select 1 from nodes n
        join workspaces w on w.owner_id = n.owner_id and w.bridge_key = 'team'
       where n.id = ${nodeId} and n.owner_id = ${ownerId} and w.id = any(n.read_ws)
    ) as ok`)) as unknown as Array<{ ok: boolean }>;
  return row?.ok === true;
}

/**
 * Give Team a read grant (Write off) on each of `ids` that Team does not
 * read yet, and log a `grant.add` event (`by: 'accept'`) for each row added.
 * A "Removed here" row comes back as a plain grant. Kinds that live in
 * Admin only are skipped. Returns the ids granted.
 *
 * @heads-held: the Accept's transaction holds the heads of every id
 * (moveIntoBrain in member-review.ts, acceptSpaceApp in member-space-apps.ts).
 */
export async function addTeamReadGrants(
  tx: Exec,
  brainId: string,
  ids: readonly string[],
  actorId: string | null,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    with team as (
      select w.id from workspaces w
       where w.owner_id = ${brainId} and w.bridge_key = 'team' and w.archived_at is null
    ), granted as (
      insert into item_grants (node_id, workspace_id, write, granted_by)
      select n.id, t.id, false, ${actorId}::uuid
        from nodes n cross join team t
       where n.id in (${list}) and n.owner_id = ${brainId}
         and not (t.id = any(n.read_ws))
         and mantle_grant_kind_ok(n.type, t.id)
      on conflict (node_id, workspace_id) do update
         set excluded = false, via_folder_id = null, write = false,
             granted_by = ${actorId}::uuid, granted_at = now()
       where item_grants.excluded
      returning node_id, workspace_id
    ), logged as (
      insert into workspace_events (workspace_id, actor_id, action, subject)
      select g.workspace_id, ${actorId}::uuid, 'grant.add',
             jsonb_build_object('node', g.node_id, 'write', false, 'by', 'accept')
        from granted g
      returning 1
    )
    select g.node_id::text as id from granted g`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
