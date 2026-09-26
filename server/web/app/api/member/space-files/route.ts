import { NextResponse } from '@/server/http-compat';
import { SPACE_FILE_MAX_BYTES, createMineFile, getMineItem } from '@mantle/content';
import {
  SpacesRootUnavailableError,
  UploadTooLargeError,
  discardSpooled,
  spaceSpoolDir,
  spacesRootAvailable,
  sweepSpool,
} from '@mantle/files';
import { getMemberOr401 } from '@/lib/auth';
import { inMySpace, spaceStateResponse } from '@/lib/member-space';
import { readMultipartUpload, type ParsedUpload } from '@/lib/upload-stream';

/**
 * POST /api/member/space-files (multipart, one `file` part) : upload a file
 * into the member's own space: private, draft. The body streams to a spool
 * inside the spaces root (never the brain's files tree), capped at
 * SPACE_FILE_MAX_BYTES per file; the space's storage and daily limits are
 * checked before the bytes are kept (409 `quota`). Nothing is extracted or
 * indexed. Answers 201 with the item, like POST /api/member/space.
 */
export async function POST(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  if (!spacesRootAvailable()) {
    return NextResponse.json({ error: new SpacesRootUnavailableError().message }, { status: 503 });
  }
  const spoolDir = spaceSpoolDir();
  void sweepSpool(undefined, spoolDir);
  let parsed: ParsedUpload;
  try {
    parsed = await readMultipartUpload(req, { maxBytes: SPACE_FILE_MAX_BYTES, spoolDir });
  } catch (err) {
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
    const item = await inMySpace(member, async () => {
      const id = await createMineFile(member.spaceId, {
        filename: upload.filename,
        spooled: upload.spooled,
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
