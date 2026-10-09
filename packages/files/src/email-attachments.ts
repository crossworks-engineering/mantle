/**
 * Email attachments in Files, for the paths a key without the Search area
 * takes (access matrix M4). An API key reaches email only with Search
 * (docs/guide/07-api/08-api-keys.md), and the attachments of synced mail are
 * file nodes, so a key limited to Files must not list, read, copy or write
 * them. What counts as an attachment is where the file sits, the attachments
 * folder under a mail (emailAttachmentSql, @mantle/db), never its bytes: a
 * Files document that also came by mail stays an ordinary file.
 *
 * Lists drop the rows (`emailAttachmentIds`, `emailAttachmentFolders`); a
 * call that names one item or folder is refused (`reachesEmailAttachment`).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  EMAIL_ATTACHMENTS_LABEL,
  db,
  emailAttachmentFileSql,
  emailAttachmentSql,
  nodes,
} from '@mantle/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** Of `ids`, the ones that are this owner's email attachments, or items made
 *  from one (an extracted image, an auto table: access matrix T4). */
export async function emailAttachmentIds(
  ownerId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const clean = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (clean.length === 0) return new Set();
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, clean), emailAttachmentSql()))
    .limit(clean.length);
  return new Set(rows.map((r) => r.id));
}

/** Of folder `paths`, the ones that are the attachments folder of a mail
 *  (their last label is `attachments` and a mail of this owner sits above). */
export async function emailAttachmentFolders(
  ownerId: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const candidates = [
    ...new Set(paths.filter((p) => PATH_RE.test(p) && p.endsWith(`.${EMAIL_ATTACHMENTS_LABEL}`))),
  ];
  if (candidates.length === 0) return new Set();
  const parents = candidates.map((p) => p.slice(0, -(EMAIL_ATTACHMENTS_LABEL.length + 1)));
  const rows = (await db.execute(sql`
    select distinct path::text as path from nodes
     where owner_id = ${ownerId} and type = 'email'
       and path::text = any(${`{${parents.map((p) => `"${p}"`).join(',')}}`}::text[])`)) as unknown as {
    path: string;
  }[];
  const mail = new Set(rows.map((r) => r.path));
  return new Set(candidates.filter((p, i) => mail.has(parents[i]!)));
}

/** Whether a folder path is, is inside, or holds a mail's attachments. */
async function pathReaches(ownerId: string, path: string): Promise<boolean> {
  // Is, or is inside: some prefix of the path is an attachments folder.
  const labels = path.split('.');
  const prefixes = labels
    .map((label, i) =>
      label === EMAIL_ATTACHMENTS_LABEL ? labels.slice(0, i + 1).join('.') : null,
    )
    .filter((p): p is string => p !== null);
  if (prefixes.length && (await emailAttachmentFolders(ownerId, prefixes)).size > 0) return true;
  // Holds one below it. The folder rule only: an item made from an
  // attachment sits in an ordinary folder (Files / Auto-filed, Tables), and
  // counting it here would close that whole tree, the root included. The
  // copy itself is refused by id (emailAttachmentIds).
  const [hit] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        sql`${nodes.path} <@ ${path}::ltree`,
        emailAttachmentFileSql(),
      ),
    )
    .limit(1);
  return !!hit;
}

/**
 * Whether `ref` reaches an email attachment of this owner: an id that is
 * one, or names a folder that is, is inside or holds one; a folder path
 * that does. A path that is not a well-formed folder path reaches one
 * (refused: the caller cannot tell where it points). An id that is not an
 * item of this owner does not (the tool answers its own "not found").
 */
export async function reachesEmailAttachment(
  ownerId: string,
  ref: { id?: string; path?: string },
): Promise<boolean> {
  if (ref.id !== undefined) {
    if (!UUID_RE.test(ref.id)) return false;
    const [row] = await db
      .select({ type: nodes.type, path: nodes.path })
      .from(nodes)
      .where(and(eq(nodes.id, ref.id), eq(nodes.ownerId, ownerId)))
      .limit(1);
    if (!row) return false;
    if (row.type === 'branch') return pathReaches(ownerId, String(row.path));
    return (await emailAttachmentIds(ownerId, [ref.id])).size > 0;
  }
  if (ref.path !== undefined) {
    const path = ref.path.trim();
    if (!PATH_RE.test(path)) return true;
    return pathReaches(ownerId, path);
  }
  return false;
}
