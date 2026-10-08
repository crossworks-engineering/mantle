/**
 * Which files are email attachments. Each attachment of a synced mail is a
 * `file` node (packages/email/src/sync.ts), linked by `email_attachments`,
 * so Files lists and reads would show them. An API key reaches email only
 * with the Search area (docs/guide/07-api/08-api-keys.md); a key limited to
 * Files must not list, read or download them (access matrix M4). These two
 * lookups are what the key paths filter by.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Of `ids`, the ones that are this owner's email attachments. */
export async function emailAttachmentIds(
  ownerId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const clean = ids.filter((id) => UUID_RE.test(id));
  if (clean.length === 0) return new Set();
  const rows = (await db.execute(sql`
    select distinct ea.file_node_id::text as id
      from email_attachments ea
      join nodes f on f.id = ea.file_node_id
     where f.owner_id = ${ownerId}
       and ea.file_node_id = any(${`{${clean.join(',')}}`}::uuid[])`)) as unknown as {
    id: string;
  }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether `ref` reaches an email attachment of this owner: an id that is
 * one, or names a folder that holds one; a folder path that holds one.
 */
export async function reachesEmailAttachment(
  ownerId: string,
  ref: { id?: string; path?: string },
): Promise<boolean> {
  if (ref.id !== undefined) {
    if (!UUID_RE.test(ref.id)) return false;
    const rows = (await db.execute(sql`
      select 1 from email_attachments ea
        join nodes f on f.id = ea.file_node_id
        join nodes x on x.id = ${ref.id}::uuid and x.owner_id = ${ownerId}
       where f.owner_id = ${ownerId}
         and (f.id = x.id or (x.type = 'branch' and f.path <@ x.path))
       limit 1`)) as unknown as unknown[];
    return rows.length > 0;
  }
  if (ref.path !== undefined) {
    const path = ref.path.trim();
    if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(path)) return false;
    const rows = (await db.execute(sql`
      select 1 from email_attachments ea
        join nodes f on f.id = ea.file_node_id
       where f.owner_id = ${ownerId} and f.path <@ ${path}::ltree
       limit 1`)) as unknown as unknown[];
    return rows.length > 0;
  }
  return false;
}
