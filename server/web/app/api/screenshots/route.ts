import { promises as fs } from 'node:fs';
import { NextResponse } from '@/server/http-compat';
import {
  discardSpooled,
  PNG_HEADER_BYTES,
  pngDimensions,
  screenshotTooLarge,
  sweepSpool,
  saveExport,
  screenshotFilename,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_PIXELS,
  SCREENSHOT_MAX_SIDE,
  SCREENSHOT_TAG,
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { ownerCaller } from '@/lib/auth';
import { parseScreenshotMeta } from '@/lib/screenshot-meta';
import { readMultipartUpload, type ParsedUpload } from '@/lib/upload-stream';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    creates: true,
    item: { none: 'creates an item: ?ws= names where it lands' },
    // Per login, an Admin user's too: each one spools up to 10 MB to disk.
    limits: { rateLimit: ['screenshots'] },
  },
});

/**
 * Save an area screenshot (docs/files.md, "Screenshots"): any signed-in
 * login, a member too, as a new file would be. A multipart `file` (a PNG,
 * by its declared Content-Type and its bytes, at most 10 MB) and `meta` (a
 * JSON string, lib/screenshot-meta.ts). Its IHDR header says how big the
 * picture is: at most 16384 pixels a side and 64 megapixels (413 above),
 * since a PNG of one colour holds a huge picture in a few bytes and every
 * reader decodes it. The body streams to the upload
 * spool (lib/upload-stream.ts, as POST /api/files/files): busboy reads the
 * part's declared type the same on Node and Bun, where Bun's formData()
 * reports one from the filename. It lands by the export rule (saveExport):
 * Auto-filed / Screenshots / <month> for a caller that may change it, else
 * the top of Files in the create home (`?ws=`, else the caller's private
 * workspace). Wherever it lands it is private to the login that took it
 * (nodes.login_id): only that login lists, opens or reads it, so no other
 * Admin user reads an Admin user's in Auto-filed. Named
 * `screenshot-<yyyy-mm-dd-hhmmss>.png` (UTC), the next free name when
 * taken; tagged `screenshot`, the metadata in `data.screenshot`.
 * Limited per login (`screenshots`, lib/route-limits.ts), an Admin user's
 * too. The body is held to the file cap plus the multipart framing
 * (lib/body-limit.ts MULTIPART_CEILINGS), a chunked one too.
 * Answers 201 `{ file: { id, filename, sizeBytes, mimeType }, landedIn }`.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  const noFile = () =>
    NextResponse.json({ error: 'multipart field `file` required' }, { status: 400 });
  if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) return noFile();
  // Over the cap (UploadTooLargeError): 413 with the cap, by the one table;
  // a malformed body is an InputError (400, the parser's text).
  // Spools an earlier request left behind go first, as on the files upload.
  void sweepSpool();
  const parsed = await readMultipartUpload(req, { maxBytes: SCREENSHOT_MAX_BYTES });
  const upload = parsed.file;
  if (!upload) return noFile();
  try {
    // The login, never the brain: an Admin user's actor, a member's own id.
    return await save({ ownerId: user.id, loginId: user.actor.id }, upload, parsed.fields.meta);
  } finally {
    // No-op once adopted (the rename moved it); every refusal and failure
    // before that leaves nothing in the spool.
    await discardSpooled(upload.spooled);
  }
}

async function save(
  { ownerId, loginId }: { ownerId: string; loginId: string },
  upload: NonNullable<ParsedUpload['file']>,
  rawMeta: string | undefined,
): Promise<Response> {
  if (upload.spooled.size === 0) {
    return NextResponse.json({ error: 'empty file' }, { status: 400 });
  }
  const notPng = () =>
    NextResponse.json({ error: 'a screenshot must be a PNG image' }, { status: 415 });
  if (upload.mimeType.split(';')[0]!.trim().toLowerCase() !== 'image/png') return notPng();
  // The signature and the IHDR header: no PNG without both.
  const size = pngDimensions(await headOf(upload.spooled.tempPath, PNG_HEADER_BYTES));
  if (!size) return notPng();
  if (screenshotTooLarge(size)) {
    return NextResponse.json(
      {
        error: `a screenshot is at most ${SCREENSHOT_MAX_SIDE} pixels a side and ${SCREENSHOT_MAX_PIXELS / 1_000_000} megapixels`,
        width: size.width,
        height: size.height,
      },
      { status: 413 },
    );
  }

  const now = new Date();
  const meta = parseScreenshotMeta(rawMeta, now);
  if (!meta.ok) return NextResponse.json({ error: meta.error }, { status: 400 });

  const saved = await saveExport({
    ownerId,
    filename: screenshotFilename(now),
    spooled: upload.spooled,
    source: 'screenshots',
    tags: [SCREENSHOT_TAG],
    data: { screenshot: meta.meta },
    loginId,
  });
  const row = saved.file;
  void recordIngest({
    source: 'screenshot',
    ownerId,
    nodeId: row.id,
    summary: `Screenshot saved: ${row.filename}`,
    payload: {
      parentPath: row.parentPath,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      via: 'web_screenshot',
      ...(meta.meta.screen ? { screen: meta.meta.screen } : {}),
    },
  });
  return NextResponse.json(
    {
      file: {
        id: row.id,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
        mimeType: row.mimeType,
      },
      landedIn: saved.landedIn,
    },
    { status: 201 },
  );
}

/** The first `n` bytes of the file at `path` (fewer when it is shorter). */
async function headOf(path: string, n: number): Promise<Buffer> {
  const fh = await fs.open(path, 'r');
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(n), 0, n, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
