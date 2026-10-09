/**
 * What Team admin > Clients reads of the client tier's use (client logins C5
 * audit, I5): each client space's storage against the client limits, and
 * the clean-up of a deleted client login's old comments (comments are gone
 * from the brain since 2026-10-09; the rows a client wrote earlier still go
 * with their login). Admin pool only: the routes call it after
 * getOwnerOr401, at level admin. No LLM work anywhere.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

/** One client space's use. A FORMER client (the login was deleted, the
 *  space waits for its 30-day purge and still counts toward the total) has
 *  no login row: `loginId` is then the space's id and `former` is true. */
export type ClientStorageRow = {
  loginId: string;
  name: string;
  usedBytes: number;
  uploadedTodayBytes: number;
  items: number;
  openSubmissions: number;
  former: boolean;
};

/** Every client space (a current client's, disabled ones included, and a
 *  former client's until its purge), largest first, at most 500. */
export async function clientStorageRows(): Promise<ClientStorageRow[]> {
  const rows = (await db.execute(sql`
    select u.space_id, u.login_id, u.bytes::text as bytes,
           a.display_name, a.email,
           (select coalesce(sum(su.bytes), 0)::text from space_uploads su
             where su.space_id = u.space_id
               and su.created_at > now() - interval '24 hours') as today,
           (select count(*)::int from nodes n
             where n.owner_id = u.space_id and n.type <> 'branch') as items,
           (select count(*)::int from space_items si
             where u.login_id is not null and si.author_login_id = u.login_id
               and si.review_state in ('submitted', 'taken')
               and si.taken_root is null) as open
      from mantle_client_space_usage() u
      left join auth.users a on a.id = u.login_id
     order by u.bytes desc, a.email
     limit 500`)) as unknown as {
    space_id: string;
    login_id: string | null;
    bytes: string;
    display_name: string | null;
    email: string | null;
    today: string;
    items: number;
    open: number;
  }[];
  return rows.map((r) => ({
    loginId: r.login_id ?? r.space_id,
    name: r.login_id
      ? r.display_name?.trim() || r.email || 'Client'
      : 'Former client (deleted, waiting for its purge)',
    usedBytes: Number(r.bytes),
    uploadedTodayBytes: Number(r.today),
    items: r.items,
    openSubmissions: r.open,
    former: !r.login_id,
  }));
}

/**
 * What the databases of this brain's CLIENT-level apps hold, in bytes (client
 * tier audit I1): clients write them, but they are not part of the client
 * space limits (each app file has its own cap, APP_SQL_MAX_DB_MB). The size
 * recorded at each app's last write (`app_databases.size_bytes`).
 */
export async function clientAppDbBytes(brainId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    select coalesce(sum(d.size_bytes), 0)::text as bytes
      from app_databases d
      join nodes n on n.id = d.app_node_id
     where d.owner_id = ${brainId} and n.audience = 'client'`)) as unknown as {
    bytes: string;
  }[];
  return Number(row?.bytes ?? 0);
}

/**
 * Delete every comment a client login wrote on this brain before comments
 * were removed (2026-10-09): its old client-thread and review rows (author
 * kind client, that login). Nothing writes comments any more; the old rows
 * still go with their login. Returns how many went. `via`: the login delete runs it in its own transaction, before the
 * login row goes (audit I5): once the login is gone its comments keep no
 * login id, so nothing could find them any more.
 */
export async function deleteClientComments(
  brainId: string,
  loginId: string,
  via: Pick<typeof db, 'execute'> = db,
): Promise<number> {
  const gone = (await via.execute(sql`
    delete from node_comments
     where owner_id = ${brainId} and author_kind = 'client' and login_id = ${loginId}
    returning id`)) as unknown as { id: string }[];
  return gone.length;
}
