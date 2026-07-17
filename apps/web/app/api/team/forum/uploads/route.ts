/**
 * POST /api/team/forum/uploads — stage member file uploads for a forum post.
 *
 * Multipart (`file` entries, ≤5 per request; optional `topicId` when the
 * reply composer knows its topic). Bytes go to the QUARANTINE (outside the
 * files ltree — nothing ingests), rows to forum_uploads as 'staged'. The
 * composer then references the returned blob ids in its post's
 * `attachmentIds`; binding happens in the post's own transaction. Staged
 * blobs whose post never came are swept here opportunistically after 24h.
 *
 * Cost guards: its own burst limiter (uploads are heavier than posts, so
 * they don't share the forum-post bucket) + a per-member daily byte budget
 * (env TEAM_UPLOAD_DAILY_BYTES, default 100 MB) — same philosophy as the
 * turn caps: a leaked token must never fill the disk.
 */
import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';
import { UPLOAD_DAILY_BYTES } from '@/lib/forum-gate';
import {
  attachmentKindForMime,
  deleteForumUploadRow,
  getForumTopic,
  listStaleStagedForumUploads,
  recordTeamAccess,
  stageForumUpload,
  sumForumUploadBytesSince,
} from '@mantle/content';
import {
  MAX_UPLOAD_BYTES,
  deleteQuarantineBytes,
  extOf,
  mimeForExt,
  sanitizeFilename,
  writeQuarantineBytes,
} from '@mantle/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILES_PER_POST = 5;

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reap staged rows whose post never came (>24h). Bytes first, then the row —
 *  a crash mid-sweep leaves a re-sweepable row, never orphan bytes. */
async function sweepStaleStaged(ownerId: string): Promise<void> {
  try {
    for (const stale of await listStaleStagedForumUploads(ownerId)) {
      await deleteQuarantineBytes(ownerId, stale.id);
      await deleteForumUploadRow(ownerId, stale.id);
    }
  } catch (err) {
    console.warn('[team/forum/uploads] stale sweep failed:', err);
  }
}

export async function POST(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { ownerId, contactId, channel } = caller;

  const gate = rateLimit(`forum-upload:${contactId}`, { max: 10, windowMs: 60_000 });
  if (!gate.ok) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'rate_limit', surface: 'forum-uploads' },
    });
    return NextResponse.json(
      { error: 'too many uploads — give it a moment' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'multipart form data required' }, { status: 400 });

  const topicIdRaw = form.get('topicId');
  let topicId: string | undefined;
  if (typeof topicIdRaw === 'string' && topicIdRaw.length > 0) {
    if (!UUID_RE.test(topicIdRaw)) {
      return NextResponse.json({ error: 'invalid topic id' }, { status: 400 });
    }
    // Visibility-checked so a blob can't be staged against a topic the member
    // can't even see (absent == forbidden, same 404 as everywhere else).
    const topic = await getForumTopic(ownerId, topicIdRaw, { kind: 'member', contactId });
    if (!topic) return NextResponse.json({ error: 'topic not found' }, { status: 404 });
    topicId = topicIdRaw;
  }

  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'at least one file is required' }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_POST) {
    return NextResponse.json(
      { error: `at most ${MAX_FILES_PER_POST} files per post` },
      { status: 400 },
    );
  }
  for (const file of files) {
    if (file.size === 0) {
      return NextResponse.json({ error: `'${file.name}' is empty` }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `'${file.name}' is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
        { status: 413 },
      );
    }
  }

  const incoming = files.reduce((sum, f) => sum + f.size, 0);
  const spentToday = await sumForumUploadBytesSince(ownerId, contactId, startOfTodayUtc());
  if (spentToday + incoming > UPLOAD_DAILY_BYTES) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'daily_bytes', cap: UPLOAD_DAILY_BYTES, surface: 'forum-uploads' },
    });
    return NextResponse.json(
      { error: 'daily upload limit reached — try again tomorrow' },
      { status: 429 },
    );
  }

  try {
    const uploads = [];
    for (const file of files) {
      const filename = sanitizeFilename(file.name) ?? `upload.${extOf(file.name) || 'bin'}`;
      const mime = file.type?.trim() || mimeForExt(extOf(filename));
      // Row first, then bytes: a crash between the two leaves a byteless
      // staged row for the 24h sweep — never unaccounted bytes on disk.
      const row = await stageForumUpload({
        ownerId,
        contactId,
        ...(topicId ? { topicId } : {}),
        filename,
        mime,
        sizeBytes: file.size,
      });
      try {
        await writeQuarantineBytes(ownerId, row.id, Buffer.from(await file.arrayBuffer()));
      } catch (err) {
        await deleteForumUploadRow(ownerId, row.id).catch(() => {});
        throw err;
      }
      uploads.push({
        blobId: row.id,
        filename,
        mime,
        size: file.size,
        kind: attachmentKindForMime(mime),
      });
    }

    recordTeamAccess({
      ownerId,
      contactId,
      kind: channel === 'api' ? 'api' : 'turn',
      detail: {
        surface: 'forum-uploads',
        action: 'stage',
        count: uploads.length,
        bytes: incoming,
        ...(topicId ? { topicId } : {}),
      },
    });

    // Opportunistic reaping of abandoned staged blobs; never blocks the reply.
    void sweepStaleStaged(ownerId);

    return NextResponse.json({ uploads }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[team/forum/uploads]', msg);
    return NextResponse.json(
      { error: 'something went wrong staging that upload — the brain admin can see the details' },
      { status: 500 },
    );
  }
}
