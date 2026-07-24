import { NextResponse } from '@/server/http-compat';
import { deleteAccount } from '@mantle/microsoft';
import { getOwnerOr401 } from '@/lib/auth';

/** Disconnect a connected Microsoft account — drops the sealed tokens + row.
 *  Content already ingested is not removed. Was `disconnectMsAccount`. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  await deleteAccount(user.id, id);
  return NextResponse.json({ ok: true });
}
