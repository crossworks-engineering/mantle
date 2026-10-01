// DELETE /api/push/subscriptions/:id — unpair a device. Removes the local row
// and (best-effort) tells the relay to drop its device row too.

import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteSubscription, forgetRelayDevices } from '@/lib/push/store';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const { id } = await params;
  const routingToken = await deleteSubscription(owner.id, id);
  if (!routingToken) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Best effort: the row is gone either way.
  await forgetRelayDevices([routingToken]);
  return NextResponse.json({ ok: true });
}
