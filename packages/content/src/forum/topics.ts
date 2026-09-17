/**
 * Forum · topic lifecycle. Creating a topic, and the owner-side flips that
 * change its standing rather than its content: pin, status, and the per-viewer
 * read cursor.
 *
 * A topic with zero posts cannot exist, so `createForumTopic` writes the topic
 * and its opening post in ONE transaction — including the upload bind, so a
 * failed bind rolls the whole topic back.
 */
import { and, eq } from 'drizzle-orm';
import {
  db,
  forumPosts,
  forumReadCursors,
  forumTopics,
  type ConversationAttachment,
  type ForumPost,
  type ForumTopic,
  type ForumTopicKind,
  type ForumTopicStatus,
  type ForumTopicVisibility,
  type TeamChannel,
} from '@mantle/db';
import type { ForumAuthor, ForumViewer } from '../forum-visibility';
import { bindForumUploadsTx } from '../forum-uploads';
import { TITLE_MAX, memberName, readerIdOf } from './shared';

export type CreateForumTopicInput = {
  ownerId: string;
  title: string;
  /** Body of the opening post. */
  body: string;
  kind?: ForumTopicKind;
  visibility?: ForumTopicVisibility;
  author: Exclude<ForumAuthor, { kind: 'agent' }>;
  channel?: TeamChannel;
  attachments?: ConversationAttachment[];
  /** Staged forum_uploads ids the attachments reference (attachment.fileId).
   *  Bound to the opening post INSIDE the create transaction — a failed bind
   *  rolls the topic back. Member authors only. */
  bindUploadIds?: string[];
};

/** Create a topic together with its opening post (one transaction — a topic
 *  with zero posts cannot exist). Returns both rows. */
export async function createForumTopic(
  input: CreateForumTopicInput,
): Promise<{ topic: ForumTopic; post: ForumPost }> {
  const title = input.title.trim().slice(0, TITLE_MAX);
  const body = input.body.trim();
  if (!title) throw new Error('forum: a topic title is required');
  if (!body) throw new Error('forum: an opening post is required');

  const authorName =
    input.author.kind === 'member'
      ? await memberName(input.ownerId, input.author.contactId)
      : input.author.name;
  const contactId = input.author.kind === 'member' ? input.author.contactId : null;
  if (input.bindUploadIds?.length && !contactId) {
    throw new Error('forum: only member posts carry uploads');
  }

  return db.transaction(async (tx) => {
    const [topic] = await tx
      .insert(forumTopics)
      .values({
        ownerId: input.ownerId,
        title,
        kind: input.kind ?? 'question',
        visibility: input.visibility ?? 'team',
        createdByContactId: contactId,
        authorName,
        postCount: 1,
      })
      .returning();
    if (!topic) throw new Error('forum: topic insert returned no row');
    const [post] = await tx
      .insert(forumPosts)
      .values({
        ownerId: input.ownerId,
        topicId: topic.id,
        authorKind: input.author.kind,
        contactId,
        authorName,
        body,
        channel: input.channel ?? 'web',
        attachments: input.attachments ?? [],
      })
      .returning();
    if (!post) throw new Error('forum: post insert returned no row');
    if (input.bindUploadIds?.length && contactId) {
      await bindForumUploadsTx(tx, {
        ownerId: input.ownerId,
        contactId,
        topicId: topic.id,
        postId: post.id,
        ids: input.bindUploadIds,
      });
    }
    return { topic, post };
  });
}

/** Mark a topic read for this viewer up to now. Upsert on the composite PK.
 *  Best-effort — a failed cursor write must never break a view. */
export async function markForumTopicRead(
  ownerId: string,
  viewer: ForumViewer,
  topicId: string,
): Promise<void> {
  await db
    .insert(forumReadCursors)
    .values({ ownerId, readerId: readerIdOf(ownerId, viewer), topicId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [forumReadCursors.ownerId, forumReadCursors.readerId, forumReadCursors.topicId],
      set: { lastReadAt: new Date() },
    })
    .catch(() => {
      /* best-effort — the unread dot is a convenience, not a gate */
    });
}

/** Owner-only: pin/unpin (the announcement mechanism). True if a row changed. */
export async function setForumTopicPinned(
  ownerId: string,
  topicId: string,
  pinned: boolean,
): Promise<boolean> {
  const rows = await db
    .update(forumTopics)
    .set({ pinned, updatedAt: new Date() })
    .where(and(eq(forumTopics.id, topicId), eq(forumTopics.ownerId, ownerId)))
    .returning({ id: forumTopics.id });
  return rows.length > 0;
}

/** Flip a topic's lifecycle status. True if a row changed. */
export async function setForumTopicStatus(
  ownerId: string,
  topicId: string,
  status: ForumTopicStatus,
): Promise<boolean> {
  const rows = await db
    .update(forumTopics)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(forumTopics.id, topicId), eq(forumTopics.ownerId, ownerId)))
    .returning({ id: forumTopics.id });
  return rows.length > 0;
}
