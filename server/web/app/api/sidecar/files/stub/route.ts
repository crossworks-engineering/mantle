/**
 * POST /api/sidecar/files/stub (Sync service plan M3; lib/sidecar-files.ts):
 * a drive file past the box's streamed upload cap (maxStreamedUploadBytes,
 * MANTLE_MAX_UPLOAD_MB). It is not fetched, but it is in the brain: a file
 * node by name with its size, whose status says it was not taken in
 * (`file_too_large`), and its map row, so an unchanged file is not posted
 * again and a changed one (or one that fits a raised cap) is.
 */
import { NextResponse } from '@/server/http-compat';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { FileStubBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';
import { FILE_PATH_RE, storeSyncedStub } from '@/lib/sidecar-files';

export const policy = routePolicy({
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, FileStubBody, { refuseEmpty: true });
  if (!FILE_PATH_RE.test(body.path)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const stored = await asSidecar(async () =>
    storeSyncedStub(await sidecarOwner(), {
      source: body.source,
      itemId: body.item,
      path: body.path,
      name: body.name,
      mimeType: body.mime,
      hash: body.hash ?? null,
      size: body.size,
      modTime: body.mod ?? null,
    }),
  );
  return NextResponse.json(stored);
}
