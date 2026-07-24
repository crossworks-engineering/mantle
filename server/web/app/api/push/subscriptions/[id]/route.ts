// DELETE /api/push/subscriptions/:id — unpair a device. Removes the local row
// and (best-effort) tells the relay to drop its device row too.

import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteSubscription, getPushInstance } from '@/lib/push/store';
import { relayDeleteDevice } from '@/lib/push/relay-client';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const { id } = await params;
  const routingToken = await deleteSubscription(owner.id, id);
  if (!routingToken) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const instance = await getPushInstance();
  if (instance) {
    void relayDeleteDevice(instance.relayUrl, instance.instanceToken, routingToken);
  }
  return NextResponse.json({ ok: true });
}
