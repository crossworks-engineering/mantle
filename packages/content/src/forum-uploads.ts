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
import { and, asc, count, eq, gte, inArray, isNull, lt, or, sql as dsql } from 'drizzle-orm';
import { db, forumTopics, forumUploads, nodes, type ForumUpload } from '@mantle/db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Start of the current UTC day — the daily upload-budget window boundary. */
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** One file's metadata for staging (bytes are written to quarantine by the
 *  route, keyed by the returned row id). Filename already sanitized. */
export type StageForumUploadFile = { filename: string; mime: string; sizeBytes: number };

export type StageForumUploadInput = {
  ownerId: string;
  contactId: string;
  /** Known for the reply composer; absent for the new-topic dialog (its
   *  topic doesn't exist yet — binding sets it). */
  topicId?: string;
  files: StageForumUploadFile[];
  /** Per-member daily byte budget (env-derived by the route). */
  dailyCapBytes: number;
};

export type StageForumUploadResult =
  { ok: true; rows: ForumUpload[] } | { ok: false; reason: 'daily_bytes'; spent: number };

/**
 * Stage a batch of uploads, enforcing the per-member daily byte budget
 * ATOMICALLY. A transaction-scoped advisory lock keyed on (owner, contact)
 * serializes concurrent staging for the same member, so the check-then-insert
 * can't be raced: a second request blocks until the first commits, then sums
 * the first's rows in. Rows are inserted `status='staged'`; the route writes
 * their quarantine bytes after this returns (row-first — a crash leaves a
 * byteless row the reconcile pass reclaims, never orphan bytes).
 *
 * Budget counts every row created in the UTC-day window regardless of later
 * review outcome — a dismissal never refunds quota (the transfer happened).
 */
export async function stageForumUploadsWithinBudget(
  input: StageForumUploadInput,
): Promise<StageForumUploadResult> {
  const incoming = input.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const since = startOfUtcDay();
  return db.transaction(async (tx) => {
    // Serialize this member's staging so the sum below sees every committed
    // peer. hashtextextended → bigint keyspace, namespaced by a literal prefix.
    await tx.execute(
      dsql`select pg_advisory_xact_lock(hashtextextended(${`forum-upload:${input.ownerId}:${input.contactId}`}, 0))`,
    );
    const [row] = await tx
      .select({ total: dsql<number>`coalesce(sum(${forumUploads.sizeBytes}), 0)::bigint` })
      .from(forumUploads)
      .where(
        and(
          eq(forumUploads.ownerId, input.ownerId),
          eq(forumUploads.contactId, input.contactId),
          gte(forumUploads.createdAt, since),
        ),
      );
    const spent = Number(row?.total ?? 0);
    if (spent + incoming > input.dailyCapBytes) {
      return { ok: false, reason: 'daily_bytes', spent };
    }
    const rows = await tx
      .insert(forumUploads)
      .values(
        input.files.map((f) => ({
          ownerId: input.ownerId,
          contactId: input.contactId,
          topicId: input.topicId ?? null,
          filename: f.filename,
          mime: f.mime,
          sizeBytes: f.sizeBytes,
          status: 'staged' as const,
        })),
      )
      .returning();
    return { ok: true, rows };
  });
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

/** The owner's review queue: pending blobs OLDEST-first (FIFO — a review queue
 *  drains front to back; the longest-waiting upload should be seen first), and
 *  bounded so a flood of pending uploads can't render an unbounded page. Pair
 *  with countPendingForumUploads to show "N of M". Annotated with topic title
 *  (for grouping) and the uploader's live contact name (null when the contact
 *  was deleted — the upload survives, same rule as posts). */
export async function listPendingForumUploads(
  ownerId: string,
  opts: { limit?: number } = {},
): Promise<PendingForumUpload[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
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
    .orderBy(asc(forumUploads.createdAt))
    .limit(limit);
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

/** Status of blob rows among `ids`, owner-scoped — the quarantine reconcile
 *  pass maps on-disk byte files to their review state (missing id ⇒ absent
 *  row ⇒ safe to unlink). */
export async function listForumUploadStatusesByIds(
  ownerId: string,
  ids: string[],
): Promise<Map<string, ForumUpload['status']>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: forumUploads.id, status: forumUploads.status })
    .from(forumUploads)
    .where(and(eq(forumUploads.ownerId, ownerId), inArray(forumUploads.id, ids)));
  return new Map(rows.map((r) => [r.id, r.status]));
}

/**
 * Atomically reap abandoned staged rows (composer opened, post never happened)
 * older than `olderThanHours`, returning the ids deleted so the caller can
 * unlink their quarantine bytes.
 *
 * The DELETE is the serialization point against a concurrent post-bind — its
 * `status = 'staged'` predicate is re-evaluated under the row lock, so:
 *   - a bind that flipped the row to 'pending' first ⇒ excluded here, row +
 *     bytes survive for the committed post (no dangling attachment);
 *   - a delete that commits first ⇒ the bind's `status = 'staged'` UPDATE
 *     matches 0 rows, throws, and rolls its post back (the member re-attaches
 *     the 24h-stale blob).
 * Either way a committed post can never reference deleted bytes. Bytes are
 * unlinked only AFTER this returns — a crash between leaves row-less bytes the
 * quarantine reconcile pass reclaims, never the reverse. */
export async function deleteStaleStagedForumUploads(
  ownerId: string,
  olderThanHours = 24,
): Promise<Array<{ id: string }>> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  return db
    .delete(forumUploads)
    .where(
      and(
        eq(forumUploads.ownerId, ownerId),
        eq(forumUploads.status, 'staged'),
        lt(forumUploads.createdAt, cutoff),
      ),
    )
    .returning({ id: forumUploads.id });
}

/** Remove one STILL-STAGED blob row (the stage route's byte-write-failure
 *  cleanup + the multi-file batch rollback). Status-guarded so it can never
 *  race-delete a row a concurrent post-bind just flipped to `pending`. Returns
 *  whether a row was removed. */
export async function deleteStagedForumUploadRow(ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(forumUploads)
    .where(
      and(
        eq(forumUploads.ownerId, ownerId),
        eq(forumUploads.id, id),
        eq(forumUploads.status, 'staged'),
      ),
    )
    .returning({ id: forumUploads.id });
  return rows.length > 0;
}
