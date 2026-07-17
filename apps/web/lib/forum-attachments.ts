/**
 * Attachment resolution shared by the two post-creating forum routes
 * (topic-create + reply). The client sends only STAGED BLOB IDS; every piece
 * of attachment metadata on the post (kind/mime/caption) is derived from the
 * blob rows the server itself wrote at stage time — the client never dictates
 * it. The actual staged→pending flip happens transactionally inside
 * createForumTopic/appendForumPost via bindUploadIds.
 */
import { attachmentKindForMime, listStagedForumUploads } from '@mantle/content';
import type { ConversationAttachment } from '@mantle/db';

export type ResolvedForumAttachments =
  | { ok: true; attachments: ConversationAttachment[]; bindIds: string[] }
  | { ok: false; error: string };

/** Load the caller's staged blobs for `ids` and shape the post's attachments
 *  jsonb. Any id that isn't the caller's own staged blob (expired, swept,
 *  already used, someone else's) fails the whole post — the member re-attaches
 *  rather than silently posting with holes. */
export async function resolveStagedAttachments(
  ownerId: string,
  contactId: string,
  ids: string[],
): Promise<ResolvedForumAttachments> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, attachments: [], bindIds: [] };
  const staged = await listStagedForumUploads(ownerId, contactId, unique);
  if (staged.length !== unique.length) {
    return {
      ok: false,
      error: 'an attachment is missing or expired — remove it and attach again',
    };
  }
  // Keep the client's attach order (staged rows come back in DB order).
  const byId = new Map(staged.map((b) => [b.id, b]));
  const attachments: ConversationAttachment[] = unique.map((id) => {
    const blob = byId.get(id)!;
    return {
      kind: attachmentKindForMime(blob.mime),
      mime: blob.mime,
      caption: blob.filename,
      fileId: blob.id,
    };
  });
  return { ok: true, attachments, bindIds: unique };
}
