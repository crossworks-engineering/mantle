import { NextResponse } from '@/server/http-compat';
import {
  SPACE_FILE_MAX_BYTES,
  SpaceItemStateError,
  createMineFile,
  getMineItem,
  spaceUploadHeadroom,
} from '@mantle/content';
import {
  SpacesRootUnavailableError,
  UploadTooLargeError,
  discardSpooled,
  spaceSpoolDir,
  spacesRootAvailable,
  sweepSpool,
} from '@mantle/files';
import { memberFilingPath } from '@mantle/content/tree';
import { z } from 'zod';
import { getMemberOr401 } from '@/lib/auth';
import { inMySpace, memberWriteGate, spaceStateResponse } from '@/lib/member-space';
import { memberTreeScope, treeErrorResponse } from '@/lib/tree-route';
import { readMultipartUpload, type ParsedUpload } from '@/lib/upload-stream';

/** Multipart framing around the file part (boundaries, part headers). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * POST /api/member/space-files (multipart, one `file` part) : upload a file
 * into the member's own space: private, draft. The body streams to a spool
 * inside the spaces root (never the brain's files tree), capped at
 * SPACE_FILE_MAX_BYTES per file. The space's storage and daily limits are
 * checked against Content-Length before the body is spooled, the spool stops
 * at the headroom, and they are checked again, under the space's quota lock,
 * before the bytes are kept (409 `quota`). Nothing is extracted or indexed.
 * Answers 201 with `{ row, body }`, the same item shape as
 * GET /api/member/space/:id. An optional `folderId` field files it in a
 * Files folder the member's tree shows (folder plan phase 5; 404 for one it
 * does not see).
 */
export async function POST(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  if (!spacesRootAvailable()) {
    return NextResponse.json({ error: new SpacesRootUnavailableError().message }, { status: 503 });
  }
  // What the space can still take, BEFORE a byte is spooled: a full space
  // or a spent daily budget answers at once instead of after 100 MB of disk.
  const headroom = await inMySpace(member, () => spaceUploadHeadroom(member.spaceId));
  const declared = Number(req.headers.get('content-length')) || 0;
  if (headroom <= 0 || declared > headroom + MULTIPART_OVERHEAD_BYTES) {
    return spaceStateResponse(
      new SpaceItemStateError(
        'quota',
        'Not enough room for this file: your space is full or today’s upload limit is used up.',
      ),
    );
  }
  const spoolDir = spaceSpoolDir();
  void sweepSpool(undefined, spoolDir);
  let parsed: ParsedUpload;
  try {
    parsed = await readMultipartUpload(req, { maxBytes: headroom, spoolDir });
  } catch (err) {
    if (err instanceof UploadTooLargeError && headroom < SPACE_FILE_MAX_BYTES) {
      return spaceStateResponse(
        new SpaceItemStateError(
          'quota',
          'Not enough room for this file: your space is full or today’s upload limit is used up.',
        ),
      );
    }
    if (err instanceof UploadTooLargeError) {
      return NextResponse.json(
        { error: `${err.message}.`, maxUploadBytes: SPACE_FILE_MAX_BYTES },
        { status: 413 },
      );
    }
    return NextResponse.json({ error: 'Malformed upload.' }, { status: 400 });
  }
  const upload = parsed.file;
  if (!upload) return NextResponse.json({ error: 'A file is required.' }, { status: 400 });
  const folderId = z
    .string()
    .uuid()
    .optional()
    .safeParse(parsed.fields.folderId || undefined);
  if (!folderId.success) {
    await discardSpooled(upload.spooled);
    return NextResponse.json({ error: 'Invalid folder.' }, { status: 400 });
  }
  let path: string | undefined;
  if (folderId.data) {
    try {
      path = await memberFilingPath(memberTreeScope(member), 'files', folderId.data);
    } catch (err) {
      await discardSpooled(upload.spooled);
      return treeErrorResponse(err);
    }
  }
  if (upload.spooled.size === 0) {
    await discardSpooled(upload.spooled);
    return NextResponse.json({ error: 'The file is empty.' }, { status: 400 });
  }
  try {
    const item = await inMySpace(member, async () => {
      const id = await createMineFile(member.spaceId, {
        filename: upload.filename,
        spooled: upload.spooled,
        path,
      });
      return getMineItem(member.spaceId, id);
    });
    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid filename') {
      return NextResponse.json({ error: 'Invalid file name.' }, { status: 400 });
    }
    return spaceStateResponse(err);
  } finally {
    // No-op once adopted; the safety net for every failure before it.
    await discardSpooled(upload.spooled);
  }
}
