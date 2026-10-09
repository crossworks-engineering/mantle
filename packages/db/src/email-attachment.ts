/**
 * Which file nodes are email attachments, by where they sit (access matrix
 * M4 and H1). Mail sync writes each email node at its branch path and each
 * new attachment file at `<that path>.attachments` (packages/email/src/
 * sync.ts), stamped `data.emailAttachment` (EMAIL_ATTACHMENT_MARK). So a
 * file is an attachment when its folder's last label is `attachments` and
 * either the file carries the stamp or an email of the same owner sits at
 * the path above (a file synced before the stamp; migration 0239 stamps
 * those). The stamp is what holds once the owner deletes the emails: the
 * attachment files stay where they are, and without it they would count as
 * ordinary files from then on (access matrix T20).
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

/** The `data` key mail sync stamps (true) on an attachment file it creates.
 *  Counts only while the file sits in an attachments folder (see the top). */
export const EMAIL_ATTACHMENT_MARK = 'emailAttachment';

/** The folder rule on a `nodes` row (raw SQL fragments for its columns): a
 *  file in an attachments folder, stamped by sync or with an email of the
 *  same owner just above it. */
function attachmentFileRule(c: { type: SQL; path: SQL; ownerId: SQL; data: SQL }): SQL {
  return sql`(${c.type}::text = 'file'
    and nlevel(${c.path}) >= 2
    and subpath(${c.path}, -1) = ${EMAIL_ATTACHMENTS_LABEL}::ltree
    and (coalesce((${c.data}->>${sql.raw(`'${EMAIL_ATTACHMENT_MARK}'`)}) = 'true', false)
      or exists (
        select 1 from nodes mail_parent
         where mail_parent.owner_id = ${c.ownerId}
           and mail_parent.type = 'email'
           and mail_parent.path = subpath(${c.path}, 0, nlevel(${c.path}) - 1))))`;
}

/** The folder rule on the `nodes` row named `alias`. */
function inAttachmentsFolder(alias: string): SQL {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return attachmentFileRule({
    type: col('type'),
    path: col('path'),
    ownerId: col('owner_id'),
    data: col('data'),
  });
}

/** True on a `nodes` row that is a FILE in a mail's attachments folder (the
 *  folder rule alone; see the top). */
export function emailAttachmentFileSql(): SQL {
  return attachmentFileRule({
    type: sql`${nodes.type}`,
    path: sql`${nodes.path}`,
    ownerId: sql`${nodes.ownerId}`,
    data: sql`${nodes.data}`,
  });
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
