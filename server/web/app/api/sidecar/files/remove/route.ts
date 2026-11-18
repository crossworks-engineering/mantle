/**
 * POST /api/sidecar/files/remove (Sync service plan M3): drive items gone from
 * their drive, or out of its selection, after a complete listing. Their map
 * rows go, and each file node no other row holds and a drive sync made
 * (lib/sidecar-files.ts SYNC_FILE_SOURCES).
 */
import { NextResponse } from '@/server/http-compat';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { FileRemoveBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';
import { removeSyncedFiles } from '@/lib/sidecar-files';

export const policy = routePolicy({
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, FileRemoveBody, { refuseEmpty: true });
  const out = await asSidecar(async () =>
    removeSyncedFiles(await sidecarOwner(), body.source, body.itemIds),
  );
  return NextResponse.json(out);
}
