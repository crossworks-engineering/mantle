/**
 * What Team admin > Clients reads of the client tier's use (client logins C5
 * audit, I5 and U2): each client space's storage against the client limits,
 * the client threads clients wrote in lately, and the admin's "delete every
 * comment this client wrote". Admin pool only: the routes call it after
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

/** One client-level item whose client thread had a client comment lately. */
export type ClientThreadActivityRow = {
  nodeId: string;
  title: string;
  type: string;
  lastCommentAt: string;
  clientComments: number;
  lastClientName: string;
};

/**
 * The brain's items at client level whose client thread had a comment by a
 * CLIENT login in the last `days` days: newest first, at most 100, with the
 * count of client comments in the window and the newest one's author.
 */
export async function clientThreadActivity(
  brainId: string,
  days: number,
): Promise<ClientThreadActivityRow[]> {
  const rows = (await db.execute(sql`
    select n.id, n.title, n.type::text as type,
           max(c.created_at) as last_at,
           count(*)::int as n,
           (array_agg(c.author_name order by c.created_at desc))[1] as last_name
      from node_comments c
      join nodes n on n.id = c.node_id
     where c.owner_id = ${brainId}
       and c.thread_scope = 'client'
       and c.author_kind = 'client'
       and c.created_at > now() - make_interval(days => ${days})
       and n.owner_id = ${brainId}
       and n.audience = 'client'
     group by n.id, n.title, n.type
     order by max(c.created_at) desc
     limit 100`)) as unknown as {
    id: string;
    title: string;
    type: string;
    last_at: Date | string;
    n: number;
    last_name: string | null;
  }[];
  return rows.map((r) => ({
    nodeId: r.id,
    title: r.title,
    type: r.type,
    lastCommentAt: new Date(r.last_at).toISOString(),
    clientComments: r.n,
    lastClientName: r.last_name ?? 'A client',
  }));
}

/**
 * Delete every comment a client login wrote on this brain: the client
 * threads and its review talk (author kind client, that login). The day
 * ledger keeps its rows: this refunds no comment place. Returns how many
 * went.
 */
export async function deleteClientComments(brainId: string, loginId: string): Promise<number> {
  const gone = (await db.execute(sql`
    delete from node_comments
     where owner_id = ${brainId} and author_kind = 'client' and login_id = ${loginId}
    returning id`)) as unknown as { id: string }[];
  return gone.length;
}
