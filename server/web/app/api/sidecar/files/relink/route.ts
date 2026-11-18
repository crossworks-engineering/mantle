/**
 * POST /api/sidecar/files/relink (Sync service plan M3): drive items the file
 * map knows whose file is unchanged take the listing's hash, size and time;
 * their nodes stay. The first run after the copy of the old map
 * (sync-copy-accounts) re-links each file this way instead of fetching it.
 */
import { NextResponse } from '@/server/http-compat';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { FileRelinkBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarRequestRefusal } from '@/lib/sidecar';
import { relinkSyncedFiles } from '@/lib/sidecar-files';

export const policy = routePolicy({
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, FileRelinkBody, { refuseEmpty: true });
  const relinked = await asSidecar(() => relinkSyncedFiles(body.source, body.items));
  return NextResponse.json({ relinked });
}
