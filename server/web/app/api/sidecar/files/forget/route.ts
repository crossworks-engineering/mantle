/**
 * POST /api/sidecar/files/forget (Sync service plan M3): a drive switched off
 * or its account disconnected. Its file map goes; every file it brought
 * stays a normal file.
 */
import { NextResponse } from '@/server/http-compat';
import { deleteSyncSource } from '@mantle/db';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { FileForgetBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarRequestRefusal } from '@/lib/sidecar';
import { FILE_SERVICE } from '@/lib/sidecar-files';

export const policy = routePolicy({
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, FileForgetBody, { refuseEmpty: true });
  const forgotten = await asSidecar(() => deleteSyncSource(FILE_SERVICE, body.source));
  return NextResponse.json({ forgotten });
}
