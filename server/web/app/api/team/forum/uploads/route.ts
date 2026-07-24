/**
 * POST /api/team/forum/uploads — stage member file uploads for a forum post.
 *
 * Multipart (`file` entries, ≤5 per request; optional `topicId` when the
 * reply composer knows its topic). Bytes go to the QUARANTINE (outside the
 * files ltree — nothing ingests), rows to forum_uploads as 'staged'. The
 * composer then references the returned blob ids in its post's
 * `attachmentIds`; binding happens in the post's own transaction. Abandoned
 * uploads are reclaimed opportunistically here (reconcileForumQuarantine).
 *
 * Cost guards: its own burst limiter (uploads are heavier than posts, so
 * they don't share the forum-post bucket), a hard Content-Length ceiling
 * BEFORE the body is buffered, and a per-member daily byte budget enforced
 * atomically in the DB (env TEAM_UPLOAD_DAILY_BYTES, default 100 MB) — same
 * philosophy as the turn caps: a leaked token must never fill the disk.
 */
import { NextResponse } from '@/server/http-compat';
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';
import { UPLOAD_DAILY_BYTES } from '@/lib/forum-gate';
import { reconcileForumQuarantine } from '@/lib/forum-quarantine';
import {
  attachmentKindForMime,
  deleteStagedForumUploadRow,
  getForumTopic,
  recordTeamAccess,
  stageForumUploadsWithinBudget,
  type StageForumUploadFile,
} from '@mantle/content';
import {
  MAX_UPLOAD_BYTES,
  deleteQuarantineBytes,
  extOf,
  mimeForExt,
  sanitizeFilename,
  writeQuarantineBytes,
} from '@mantle/files';

const MAX_FILES_PER_POST = 5;
/** Hard body ceiling checked from Content-Length BEFORE `formData()` buffers
 *  the request into memory — the per-file/per-day guards run too late to stop
 *  a single oversized body from OOMing the process. A little slack over the
 *  theoretical max for multipart boundaries/headers. */
const MAX_BODY_BYTES = MAX_FILES_PER_POST * MAX_UPLOAD_BYTES + 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Reject an oversized body before `formData()` allocates it. A missing/
  // unparseable Content-Length falls through to the post-parse per-file guard.
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'body_too_large', bytes: declared, surface: 'forum-uploads' },
    });
    return NextResponse.json({ error: 'upload too large' }, { status: 413 });
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

  const meta = files.map((file) => {
    const filename = sanitizeFilename(file.name) ?? `upload.${extOf(file.name) || 'bin'}`;
    return {
      filename,
      mime: file.type?.trim() || mimeForExt(extOf(filename)),
      sizeBytes: file.size,
    };
  });
  const incoming = meta.reduce((sum, m) => sum + m.sizeBytes, 0);

  // Atomic budget + row insert (advisory-locked per member so concurrent
  // requests can't each pass a stale sum and blow past the cap).
  const staged = await stageForumUploadsWithinBudget({
    ownerId,
    contactId,
    ...(topicId ? { topicId } : {}),
    files: meta as StageForumUploadFile[],
    dailyCapBytes: UPLOAD_DAILY_BYTES,
  });
  if (!staged.ok) {
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

  // Write bytes for each staged row. On any failure, roll the WHOLE batch back
  // (delete every staged row + its bytes) so a mid-batch failure never leaves
  // orphan rows burning the daily budget with nothing to show.
  const uploads: Array<{
    blobId: string;
    filename: string;
    mime: string;
    size: number;
    kind: string;
  }> = [];
  try {
    for (let i = 0; i < staged.rows.length; i++) {
      const row = staged.rows[i]!;
      const m = meta[i]!;
      await writeQuarantineBytes(ownerId, row.id, Buffer.from(await files[i]!.arrayBuffer()));
      uploads.push({
        blobId: row.id,
        filename: m.filename,
        mime: m.mime,
        size: m.sizeBytes,
        kind: attachmentKindForMime(m.mime),
      });
    }
  } catch (err) {
    for (const row of staged.rows) {
      await deleteQuarantineBytes(ownerId, row.id).catch(() => {});
      await deleteStagedForumUploadRow(ownerId, row.id).catch(() => {});
    }
    console.error('[team/forum/uploads]', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: 'something went wrong staging that upload — the brain admin can see the details' },
      { status: 500 },
    );
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

  // Opportunistic quarantine GC (stale staged + orphaned bytes); never blocks.
  void reconcileForumQuarantine(ownerId).catch((err) =>
    console.warn('[team/forum/uploads] quarantine reconcile failed:', err),
  );

  return NextResponse.json({ uploads }, { status: 201 });
}
