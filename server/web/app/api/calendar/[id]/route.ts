import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteCalendarAccount, setCalendarEnabled } from '@mantle/calendar';
import { getOwnerOr401 } from '@/lib/auth';

const PatchBody = z.object({ enabled: z.boolean() });

/** Enable/disable syncing for one subscribed calendar. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  await setCalendarEnabled(user.id, id, parsed.data.enabled);
  return NextResponse.json({ ok: true });
}

/** Unsubscribe — removes the subscription and every event it synced. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  await deleteCalendarAccount(user.id, id);
  return NextResponse.json({ ok: true });
}
