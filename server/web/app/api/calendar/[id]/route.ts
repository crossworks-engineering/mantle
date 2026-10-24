import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteCalendarAccount, setCalendarEnabled } from '@mantle/calendar';
import { ownerCaller } from '@/lib/auth';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
  DELETE: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

const PatchBody = z.object({ enabled: z.boolean() });

/** Enable/disable syncing for one subscribed calendar. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const parsed = PatchBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  await setCalendarEnabled(user.id, id, parsed.data.enabled);
  return NextResponse.json({ ok: true });
}

/** Unsubscribe — removes the subscription and every event it synced. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  await deleteCalendarAccount(user.id, id);
  return NextResponse.json({ ok: true });
}
