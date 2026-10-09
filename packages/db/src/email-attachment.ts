/**
 * Which file nodes are email attachments, by where they sit (access matrix
 * M4 and H1). Mail sync writes each email node at its branch path and each
 * new attachment file at `<that path>.attachments` (packages/email/src/
 * sync.ts). So a file is an attachment when its folder's last label is
 * `attachments` and an email of the same owner sits at the path above.
 *
 * An item made FROM an attachment (its `data.sourceFileId` names one) is held
 * to the same rule (emailAttachmentSql, access matrix T4).
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

/** The folder rule on the `nodes` row named `alias` (raw SQL): a file in an
 *  attachments folder with an email of the same owner just above it. */
function inAttachmentsFolder(alias: string): SQL {
  const t = sql.raw(alias);
  return sql`(${t}.type::text = 'file'
    and nlevel(${t}.path) >= 2
    and subpath(${t}.path, -1) = ${EMAIL_ATTACHMENTS_LABEL}::ltree
    and exists (
      select 1 from nodes mail_parent
       where mail_parent.owner_id = ${t}.owner_id
         and mail_parent.type = 'email'
         and mail_parent.path = subpath(${t}.path, 0, nlevel(${t}.path) - 1)))`;
}

/** True on a `nodes` row that is a FILE in a mail's attachments folder (the
 *  folder rule alone; see the top). */
export function emailAttachmentFileSql(): SQL {
  return sql`(${nodes.type}::text = 'file'
    and nlevel(${nodes.path}) >= 2
    and subpath(${nodes.path}, -1) = ${EMAIL_ATTACHMENTS_LABEL}::ltree
    and exists (
      select 1 from nodes mail_parent
       where mail_parent.owner_id = ${nodes.ownerId}
         and mail_parent.type = 'email'
         and mail_parent.path = subpath(${nodes.path}, 0, nlevel(${nodes.path}) - 1)))`;
}

/**
 * True on a `nodes` row that is an email attachment (see the top), or an item
 * made from one: the extractor turns an attachment's figures into image files
 * and a spreadsheet attachment into a Table, and the file tools make notes,
 * pages and tables from a file, each naming its source in `data.sourceFileId`
 * (access matrix T4). Such a copy holds the attachment's content, so it
 * follows the attachment: while its source sits in a mail's attachments
 * folder it is held to the same rule, and once the source is moved out (an
 * ordinary file) the copy is ordinary too. Any node type.
 */
export function emailAttachmentSql(): SQL {
  return sql`(${emailAttachmentFileSql()}
    or (${nodes.data}->>'sourceFileId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and exists (
        select 1 from nodes att_src
         where att_src.id = (case
                 when ${nodes.data}->>'sourceFileId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (${nodes.data}->>'sourceFileId')::uuid end)
           and att_src.owner_id = ${nodes.ownerId}
           and ${inAttachmentsFolder('att_src')})))`;
}
