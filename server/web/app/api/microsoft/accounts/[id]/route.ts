import { NextResponse } from '@/server/http-compat';
import { deleteAccount } from '@mantle/microsoft';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/** Disconnect a connected Microsoft account — drops the sealed tokens + row.
 *  Content already ingested is not removed. Was `disconnectMsAccount`. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  await deleteAccount(user.id, id);
  return NextResponse.json({ ok: true });
}
