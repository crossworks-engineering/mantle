import { NextResponse } from '@/server/http-compat';
import {
  CLIENT_SPACE_LIMITS,
  SpaceItemStateError,
  createMineFile,
  getMineItem,
  recordClientQuotaRefusal,
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
import { getClientOr401 } from '@/lib/auth';
import { clientWriteGate, inMyClientSpace } from '@/lib/client-space';
import { spaceStateResponse } from '@/lib/member-space';
import { readMultipartUpload, type ParsedUpload } from '@/lib/upload-stream';

/** Multipart framing around the file part (boundaries, part headers). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** One upload's ceiling for a client (never the member's). */
const CLIENT_FILE_MAX_BYTES = CLIENT_SPACE_LIMITS.fileMaxBytes;

const NO_ROOM =
  'Not enough room for this file: your space is full or today’s upload limit is used up.';

/**
 * POST /api/client/space-files (multipart, one `file` part) : upload a file
 * into the CLIENT's own space: private, draft (client logins C5). The
 * member upload, at the client's limits: 20 MB a file (413 with
 * `maxUploadBytes`), 200 MB a client, 50 MB a day, 500 items, and one total
 * for all client uploads of the brain. The headroom is checked against
 * Content-Length before the body is spooled, the spool stops at it, and the
 * limits are checked again, under the quota locks, before the bytes are
 * kept (409 `quota`). Nothing is extracted or indexed. Answers 201 with
 * `{ row, body }`, the shape of GET /api/client/space/:id.
 */
export async function POST(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  if (!spacesRootAvailable()) {
    return NextResponse.json({ error: new SpacesRootUnavailableError().message }, { status: 503 });
  }
  // What the space can still take (the client's limits: the space scope is
  // at level client), BEFORE a byte is spooled.
  const headroom = await inMyClientSpace(client, () => spaceUploadHeadroom(client.spaceId));
  const declared = Number(req.headers.get('content-length')) || 0;
  if (headroom <= 0 || declared > headroom + MULTIPART_OVERHEAD_BYTES) {
    // A body over one file's ceiling is a 413 naming it, whatever room is
    // left; a smaller one that does not fit is a full space.
    if (declared > CLIENT_FILE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES && headroom > 0) {
      return tooLarge();
    }
    return noRoom(client.loginId);
  }
  const spoolDir = spaceSpoolDir();
  void sweepSpool(undefined, spoolDir);
  let parsed: ParsedUpload;
  try {
    parsed = await readMultipartUpload(req, { maxBytes: headroom, spoolDir });
  } catch (err) {
    if (err instanceof UploadTooLargeError && headroom < CLIENT_FILE_MAX_BYTES) {
      return noRoom(client.loginId);
    }
    if (err instanceof UploadTooLargeError) return tooLarge();
    return NextResponse.json({ error: 'Malformed upload.' }, { status: 400 });
  }
  const upload = parsed.file;
  if (!upload) return NextResponse.json({ error: 'A file is required.' }, { status: 400 });
  if (upload.spooled.size === 0) {
    await discardSpooled(upload.spooled);
    return NextResponse.json({ error: 'The file is empty.' }, { status: 400 });
  }
  try {
    const item = await inMyClientSpace(client, async () => {
      const id = await createMineFile(client.spaceId, {
        filename: upload.filename,
        spooled: upload.spooled,
      });
      return getMineItem(client.spaceId, id);
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

/** The 409 `quota` for an upload with no room, recorded for Team admin >
 *  Clients (audit I5). */
async function noRoom(loginId: string): Promise<Response> {
  await recordClientQuotaRefusal(loginId, 'upload-no-room');
  return spaceStateResponse(new SpaceItemStateError('quota', NO_ROOM));
}

/** The 413 naming the CLIENT's ceiling (never the member's). */
const tooLarge = () =>
  NextResponse.json(
    {
      error: `Files can be at most ${Math.round(CLIENT_FILE_MAX_BYTES / 1024 / 1024)} MB.`,
      maxUploadBytes: CLIENT_FILE_MAX_BYTES,
    },
    { status: 413 },
  );
