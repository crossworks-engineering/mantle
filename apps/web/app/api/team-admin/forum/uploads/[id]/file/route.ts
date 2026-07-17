/**
 * Owner-only: "Move to files" — the approve action of the forum-upload review.
 * Quarantine bytes land in `files/review/<topic-slug>/` (folders lazily
 * created), which creates a real file node and ONLY NOW triggers ingestion
 * (migration 0018's node trigger). The blob row flips to 'filed' with the
 * node id, and the quarantine bytes are deleted. Filenames are de-duped
 * against the target folder so a second same-named upload files cleanly.
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ensure files.review.<slug> exists (both levels). Tolerates the unique-index
 *  race when two reviews land together — the ensureDatedUploadFolder pattern. */
async function ensureReviewFolder(ownerId: string, slug: string): Promise<string> {
  await ensureFilesRootBranch(ownerId);
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
    const topic = blob.topicId
      ? await getForumTopic(user.id, blob.topicId, { kind: 'owner' })
      : null;
    const slug = topicFolderSlug(topic?.title ?? 'topic');
    const parentPath = await ensureReviewFolder(user.id, slug);

    const existing = await listFiles({ ownerId: user.id, parentPath });
    const filename = dedupeFilename(blob.filename, new Set(existing.map((f) => f.filename)));

    const row = await upsertFile({ ownerId: user.id, parentPath, filename, bytes });

    const marked = await markForumUploadFiled(user.id, id, row.id);
    if (!marked) {
      // Lost a review race after creating the node — undo so the loser's
      // outcome (dismissed/filed elsewhere) stays the truth.
      await deleteFileById({ ownerId: user.id, fileId: row.id }).catch(() => {});
      return NextResponse.json(
        { error: 'already reviewed — refresh to see the current queue' },
        { status: 409 },
      );
    }
    await deleteQuarantineBytes(user.id, id);

    void recordIngest({
      source: 'file_upload',
      ownerId: user.id,
      nodeId: row.id,
      summary: `Forum upload filed: ${filename}`,
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

    return NextResponse.json({ ok: true, nodeId: row.id, parentPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[team-admin/forum/uploads/file]', msg);
    return NextResponse.json({ error: 'filing failed — see the server log' }, { status: 500 });
  }
}
