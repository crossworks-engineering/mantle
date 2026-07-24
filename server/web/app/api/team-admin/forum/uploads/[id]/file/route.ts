/**
 * Owner-only: "Move to files" — the approve action of the forum-upload review.
 * Quarantine bytes land in `files/review/<topic-slug>/` (folders lazily
 * created), which creates a real file node and ONLY NOW triggers ingestion
 * (migration 0018's node trigger). The blob row flips to 'filed' with the
 * node id, and the quarantine bytes are deleted. Filenames are de-duped
 * against the target folder so a second same-named upload files cleanly.
 *
 * The whole filing runs under a per-owner in-process lock so two concurrent
 * "Move to files" clicks can't race the same folder create / dedupe / disk
 * write (which corrupts bytes) or the fresh-brain files-root creation. On a
 * crash-and-retry, an existing node with the byte's sha256 in the target
 * folder is ADOPTED rather than filed again — no duplicate corpus entry.
 */
import { createHash } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { withKeyedLock } from '@/lib/keyed-mutex';
import {
  dedupeFilename,
  getForumTopic,
  getForumUpload,
  markForumUploadFiled,
  topicFolderSlug,
} from '@mantle/content';
import {
  createFolder,
  deleteFileById,
  ensureFilesRootBranch,
  listFiles,
  upsertFile,
} from '@/lib/files';
import { dashToLtree, deleteQuarantineBytes, readQuarantineBytes } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ensure files.review.<slug> exists (both levels). Tolerates the unique-index
 *  race when two reviews land together — the ensureDatedUploadFolder pattern. */
async function ensureReviewFolder(ownerId: string, slug: string): Promise<string> {
  await ensureFilesRootBranch(ownerId).catch((err) => {
    // Concurrent first-ever filing can race the files-root insert; a duplicate
    // just means a peer created it — anything else is real.
    if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
  });
  for (const [parent, child, description] of [
    ['files', 'review', 'Member uploads approved from the team forum.'],
    ['files.review', slug, ''],
  ] as const) {
    try {
      await createFolder({ ownerId, parentPath: parent, slug: child, description });
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
    }
  }
  return `files.review.${dashToLtree(slug)}`;
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'upload not found' }, { status: 404 });

  const blob = await getForumUpload(user.id, id);
  if (!blob) return NextResponse.json({ error: 'upload not found' }, { status: 404 });
  if (blob.status !== 'pending') {
    return NextResponse.json(
      { error: `already ${blob.status} — refresh to see the current queue` },
      { status: 409 },
    );
  }

  const bytes = await readQuarantineBytes(user.id, id);
  if (!bytes) {
    return NextResponse.json(
      { error: 'the uploaded bytes are missing (swept or lost) — dismiss this entry' },
      { status: 410 },
    );
  }

  try {
    // Serialize per owner: the folder-create + dedupe + disk-write + node-insert
    // sequence is not safe to interleave with another filing for the same owner.
    return await withKeyedLock(`forum-file:${user.id}`, async () => {
      const topic = blob.topicId
        ? await getForumTopic(user.id, blob.topicId, { kind: 'owner' })
        : null;
      const slug = topicFolderSlug(topic?.title ?? 'topic');
      const parentPath = await ensureReviewFolder(user.id, slug);

      const existing = await listFiles({ ownerId: user.id, parentPath });
      // Adopt-on-retry: identical bytes already filed here (a crash between the
      // upsert and the row-mark left an orphan node) ⇒ reuse it, don't dup.
      const sha = createHash('sha256').update(bytes).digest('hex');
      const already = existing.find((f) => f.sha256 === sha);
      let nodeId: string;
      if (already) {
        nodeId = already.id;
      } else {
        const filename = dedupeFilename(blob.filename, new Set(existing.map((f) => f.filename)));
        const row = await upsertFile({ ownerId: user.id, parentPath, filename, bytes });
        nodeId = row.id;
      }

      const marked = await markForumUploadFiled(user.id, id, nodeId);
      if (!marked) {
        // Lost a review race after creating the node — undo the fresh node (not
        // an adopted pre-existing one) so the loser's outcome stays the truth.
        if (!already) await deleteFileById({ ownerId: user.id, fileId: nodeId }).catch(() => {});
        return NextResponse.json(
          { error: 'already reviewed — refresh to see the current queue' },
          { status: 409 },
        );
      }
      await deleteQuarantineBytes(user.id, id);

      if (!already) {
        void recordIngest({
          source: 'file_upload',
          ownerId: user.id,
          nodeId,
          summary: `Forum upload filed: ${blob.filename}`,
          payload: {
            via: 'forum_review',
            blobId: id,
            topicId: blob.topicId,
            contactId: blob.contactId,
            mimeType: blob.mime,
            sizeBytes: blob.sizeBytes,
            parentPath,
          },
        });
      }

      return NextResponse.json({ ok: true, nodeId, parentPath });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[team-admin/forum/uploads/file]', msg);
    return NextResponse.json({ error: 'filing failed — see the server log' }, { status: 500 });
  }
}
