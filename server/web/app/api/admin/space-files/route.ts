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
import { getAdminSpaceOr401, inAdminSpace } from '@/lib/admin-space';
import { spaceStateResponse } from '@/lib/member-space';
import { readMultipartUpload, type ParsedUpload } from '@/lib/upload-stream';

/** Multipart framing around the file part (boundaries, part headers). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * POST /api/admin/space-files (multipart, one `file` part) : upload a file
 * into the calling admin's own private space, as POST /api/member/space-files
 * (same limits, spool and answers: 201 with `{ row, body }`, the item shape
 * of GET /api/admin/space/:id). Nothing is extracted or indexed until Accept.
 */
export async function POST(req: Request) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  if (!spacesRootAvailable()) {
    return NextResponse.json({ error: new SpacesRootUnavailableError().message }, { status: 503 });
  }
  // What the space can still take, BEFORE a byte is spooled: a full space
  // or a spent daily budget answers at once instead of after 100 MB of disk.
  const headroom = await inAdminSpace(caller, () => spaceUploadHeadroom(caller.spaceId));
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
  if (upload.spooled.size === 0) {
    await discardSpooled(upload.spooled);
    return NextResponse.json({ error: 'The file is empty.' }, { status: 400 });
  }
  try {
    const item = await inAdminSpace(caller, async () => {
      const id = await createMineFile(caller.spaceId, {
        filename: upload.filename,
        spooled: upload.spooled,
      });
      return getMineItem(caller.spaceId, id);
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
