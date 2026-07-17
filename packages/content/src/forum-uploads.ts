/**
 * Forum upload store — the review-state rows behind member file uploads
 * (bytes live in the @mantle/files quarantine; this module never touches
 * disk — routes compose the two, the disk.ts/ops.ts precedent).
 *
 * Lifecycle: `staged` (uploaded from a composer, no post yet) → `pending`
 * (bound to a post at post-create time, in the post's own transaction —
 * see bindForumUploadsTx) → `filed` (owner moved it into files/review/…,
 * node_id set, ingestion ran) | `dismissed`. The post's immutable
 * `attachments` jsonb references blobs by `fileId`; these rows carry the
 * mutable review state and the two join on that id.
 */
import { and, count, desc, eq, gte, inArray, isNull, lt, or, sql as dsql } from 'drizzle-orm';
import { db, forumTopics, forumUploads, nodes, type ForumUpload } from '@mantle/db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type StageForumUploadInput = {
  ownerId: string;
  contactId: string;
  /** Known for the reply composer; absent for the new-topic dialog (its
   *  topic doesn't exist yet — binding sets it). */
  topicId?: string;
  /** Already sanitized (sanitizeFilename) by the route. */
  filename: string;
  mime: string;
  sizeBytes: number;
};

/** Insert the blob row for a fresh upload (status 'staged'). The route writes
 *  the quarantine bytes keyed by the returned id — row first, so a crashed
 *  upload leaves a byteless row for the sweep, never orphan bytes. */
export async function stageForumUpload(input: StageForumUploadInput): Promise<ForumUpload> {
  const [row] = await db
    .insert(forumUploads)
    .values({
      ownerId: input.ownerId,
      contactId: input.contactId,
      topicId: input.topicId ?? null,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      status: 'staged',
    })
    .returning();
  if (!row) throw new Error('forum-uploads: stage insert returned no row');
  return row;
}

/** The caller's own staged blobs among `ids` — the pre-bind validation read
 *  (build attachments metadata from what the DB says, never from the client). */
export async function listStagedForumUploads(
  ownerId: string,
  contactId: string,
  ids: string[],
): Promise<ForumUpload[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(forumUploads)
    .where(
      and(
        eq(forumUploads.ownerId, ownerId),
        eq(forumUploads.contactId, contactId),
        eq(forumUploads.status, 'staged'),
        inArray(forumUploads.id, ids),
      ),
    );
}

/**
 * Bind staged blobs to a just-created post, INSIDE the post's transaction —
 * called by createForumTopic/appendForumPost so a failed bind rolls the post
 * back (no post can reference blobs that never became pending). Ownership,
 * uploader, and status are all re-asserted in the WHERE; a count mismatch
 * (a blob vanished, was swept, or belongs to someone else) throws.
 * A reply's blob may have been staged with the topic already stamped; a
 * new-topic blob has none — both bind, anything staged against a DIFFERENT
 * topic does not.
 */
export async function bindForumUploadsTx(
  tx: Tx,
  args: { ownerId: string; contactId: string; topicId: string; postId: string; ids: string[] },
): Promise<void> {
  if (args.ids.length === 0) return;
  const ids = [...new Set(args.ids)];
  const bound = await tx
    .update(forumUploads)
    .set({ topicId: args.topicId, postId: args.postId, status: 'pending' })
    .where(
      and(
        eq(forumUploads.ownerId, args.ownerId),
        eq(forumUploads.contactId, args.contactId),
        eq(forumUploads.status, 'staged'),
        inArray(forumUploads.id, ids),
        or(isNull(forumUploads.topicId), eq(forumUploads.topicId, args.topicId)),
      ),
    )
    .returning({ id: forumUploads.id });
  if (bound.length !== ids.length) {
    throw new Error(
      'forum-uploads: an attachment is missing or already used — re-attach and retry',
    );
  }
}

/** One blob row, owner-scoped, any status — the serve/review lookup. */
export async function getForumUpload(ownerId: string, id: string): Promise<ForumUpload | null> {
  const [row] = await db
    .select()
    .from(forumUploads)
    .where(and(eq(forumUploads.ownerId, ownerId), eq(forumUploads.id, id)))
    .limit(1);
  return row ?? null;
}

/** Blob review states for one topic — the thread view merges these into its
 *  posts' attachment chips by fileId ("in review" badge + size). Light columns
 *  on purpose; kind/mime/filename already live in the post jsonb. */
export async function listForumUploadStatesForTopic(
  ownerId: string,
  topicId: string,
): Promise<
  Array<{ id: string; postId: string | null; status: ForumUpload['status']; sizeBytes: number }>
> {
  return db
    .select({
      id: forumUploads.id,
      postId: forumUploads.postId,
      status: forumUploads.status,
      sizeBytes: forumUploads.sizeBytes,
    })
    .from(forumUploads)
    .where(and(eq(forumUploads.ownerId, ownerId), eq(forumUploads.topicId, topicId)));
}

export type PendingForumUpload = {
  id: string;
  topicId: string | null;
  postId: string | null;
  topicTitle: string | null;
  contactId: string | null;
  contactName: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
};

/** The owner's review queue: pending blobs newest-first, annotated with topic
 *  title (for grouping) and the uploader's live contact name (null when the
 *  contact was deleted — the upload survives, same rule as posts). */
export async function listPendingForumUploads(ownerId: string): Promise<PendingForumUpload[]> {
  const rows = await db
    .select({
      id: forumUploads.id,
      topicId: forumUploads.topicId,
      postId: forumUploads.postId,
      topicTitle: forumTopics.title,
      contactId: forumUploads.contactId,
      contactName: nodes.title,
      filename: forumUploads.filename,
      mime: forumUploads.mime,
      sizeBytes: forumUploads.sizeBytes,
      createdAt: forumUploads.createdAt,
    })
    .from(forumUploads)
    .leftJoin(forumTopics, eq(forumUploads.topicId, forumTopics.id))
    .leftJoin(nodes, eq(forumUploads.contactId, nodes.id))
    .where(and(eq(forumUploads.ownerId, ownerId), eq(forumUploads.status, 'pending')))
    .orderBy(desc(forumUploads.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** Pending count for the Requests tab badge. */
export async function countPendingForumUploads(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(forumUploads)
    .where(and(eq(forumUploads.ownerId, ownerId), eq(forumUploads.status, 'pending')));
  return row?.n ?? 0;
}

/** Flip pending → filed with the created file node. The status guard makes
 *  review actions idempotent-safe: a double-click files once, the loser sees
 *  false and the route re-reads current state. */
export async function markForumUploadFiled(
  ownerId: string,
  id: string,
  nodeId: string,
): Promise<boolean> {
  const rows = await db
    .update(forumUploads)
    .set({ status: 'filed', nodeId, reviewedAt: new Date() })
    .where(
      and(
        eq(forumUploads.ownerId, ownerId),
        eq(forumUploads.id, id),
        eq(forumUploads.status, 'pending'),
      ),
    )
    .returning({ id: forumUploads.id });
  return rows.length > 0;
}

/** Flip pending → dismissed (bytes deleted by the route). Same guard. */
export async function markForumUploadDismissed(ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(forumUploads)
    .set({ status: 'dismissed', reviewedAt: new Date() })
    .where(
      and(
        eq(forumUploads.ownerId, ownerId),
        eq(forumUploads.id, id),
        eq(forumUploads.status, 'pending'),
      ),
    )
    .returning({ id: forumUploads.id });
  return rows.length > 0;
}

/** Bytes a member staged today (UTC) — the per-contact daily upload budget.
 *  Counts every row created in the window regardless of later review outcome:
 *  a dismissal must not refund quota (the transfer already happened). */
export async function sumForumUploadBytesSince(
  ownerId: string,
  contactId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: dsql<number>`coalesce(sum(${forumUploads.sizeBytes}), 0)::bigint` })
    .from(forumUploads)
    .where(
      and(
        eq(forumUploads.ownerId, ownerId),
        eq(forumUploads.contactId, contactId),
        gte(forumUploads.createdAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Staged rows older than `olderThanHours` — abandoned composer uploads whose
 *  post never happened. The upload route sweeps opportunistically: bytes
 *  first, then the row via deleteForumUploadRow, so a crash mid-sweep leaves
 *  a re-sweepable row, never orphan bytes. */
export async function listStaleStagedForumUploads(
  ownerId: string,
  olderThanHours = 24,
): Promise<ForumUpload[]> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  return db
    .select()
    .from(forumUploads)
    .where(
      and(
        eq(forumUploads.ownerId, ownerId),
        eq(forumUploads.status, 'staged'),
        lt(forumUploads.createdAt, cutoff),
      ),
    );
}

/** Remove one blob row (sweep endpoint — review outcomes keep their rows). */
export async function deleteForumUploadRow(ownerId: string, id: string): Promise<void> {
  await db
    .delete(forumUploads)
    .where(and(eq(forumUploads.ownerId, ownerId), eq(forumUploads.id, id)));
}
