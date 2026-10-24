import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { setDriveEnabled } from '@mantle/microsoft';
import { ownerCaller } from '@/lib/auth';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

const Body = z.object({ enabled: z.boolean() });

/** Enable/disable a single drive for sync (`id` = the drive db id). Owner-scoped. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  const ok = await setDriveEnabled(user.id, id, parsed.data.enabled);
  if (!ok) return NextResponse.json({ error: 'Drive not found.' }, { status: 404 });
  return NextResponse.json({ enabled: parsed.data.enabled });
}
