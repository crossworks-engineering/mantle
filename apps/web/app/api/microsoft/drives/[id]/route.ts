import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setDriveEnabled } from '@mantle/microsoft';
import { getOwnerOr401 } from '@/lib/auth';

const Body = z.object({ enabled: z.boolean() });

/** Enable/disable a single drive for sync (`id` = the drive db id). Owner-scoped. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  const ok = await setDriveEnabled(user.id, id, parsed.data.enabled);
  if (!ok) return NextResponse.json({ error: 'Drive not found.' }, { status: 404 });
  return NextResponse.json({ enabled: parsed.data.enabled });
}
