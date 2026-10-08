/**
 * Which file nodes are email attachments, by where they sit (access matrix
 * M4 and H1). Mail sync writes each email node at its branch path and each
 * new attachment file at `<that path>.attachments` (packages/email/src/
 * sync.ts). So a file is an attachment when its folder's last label is
 * `attachments` and an email of the same owner sits at the path above.
 *
 * Not by `email_attachments`: sync reuses any file node with the same bytes
 * (getOrCreateFileNode dedupes by sha256), so a document the owner keeps in
 * Files and once received by mail is linked there too, and must stay an
 * ordinary file. A file the owner moves out of the attachments folder is an
 * ordinary file from then on.
 */
import { sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/index';

/** The last label of an email's attachments folder. */
export const EMAIL_ATTACHMENTS_LABEL = 'attachments';

/** True on a `nodes` row that is an email attachment (see the top). */
export function emailAttachmentSql(): SQL {
  return sql`(${nodes.type}::text = 'file'
    and nlevel(${nodes.path}) >= 2
    and subpath(${nodes.path}, -1) = ${EMAIL_ATTACHMENTS_LABEL}::ltree
    and exists (
      select 1 from nodes mail_parent
       where mail_parent.owner_id = ${nodes.ownerId}
         and mail_parent.type = 'email'
         and mail_parent.path = subpath(${nodes.path}, 0, nlevel(${nodes.path}) - 1)))`;
}
