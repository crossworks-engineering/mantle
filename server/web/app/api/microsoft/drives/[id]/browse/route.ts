import { NextResponse } from '@/server/http-compat';
import { browseDrive, type GraphError } from '@mantle/microsoft';
import type { MsDriveChildDTO } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

/**
 * List a drive folder's children for the scope picker (`id` = drive db id;
 * `?item=<graph item id>` descends, omitted = drive root). Live Graph
 * passthrough — nothing persisted. Owner-scoped.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const itemId = new URL(req.url).searchParams.get('item') ?? undefined;
  try {
    const items = await browseDrive(user.id, id, itemId);
    if (items === null) return NextResponse.json({ error: 'Drive not found.' }, { status: 404 });
    return NextResponse.json({ items: items satisfies MsDriveChildDTO[] });
  } catch (err) {
    const status = (err as GraphError).status === 401 ? 401 : 502;
    const message =
      status === 401
        ? 'Microsoft session expired — reconnect the account.'
        : 'Could not list the folder. Try again.';
    return NextResponse.json({ error: message }, { status });
  }
}
