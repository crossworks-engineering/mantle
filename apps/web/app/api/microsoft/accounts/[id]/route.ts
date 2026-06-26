import { NextResponse } from 'next/server';
import { deleteAccount } from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';

/** Disconnect a connected Microsoft account — drops the sealed tokens + row.
 *  Content already ingested is not removed. Was `disconnectMsAccount`. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  await deleteAccount(user.id, id);
  return NextResponse.json({ ok: true });
}
