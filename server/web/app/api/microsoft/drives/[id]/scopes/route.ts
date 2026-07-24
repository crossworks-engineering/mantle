import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listScopes, ownedDrive, setDriveScopes } from '@mantle/microsoft';
import type { MsDriveScopeDTO } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

/** Wire projection of a scope row (drops db id/timestamps). */
function toScopeDTO(s: Awaited<ReturnType<typeof listScopes>>[number]): MsDriveScopeDTO {
  return { itemId: s.itemId, path: s.path, isFolder: s.isFolder, name: s.name };
}

/** The drive's current scope selections (empty = syncing everything). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!(await ownedDrive(user.id, id))) {
    return NextResponse.json({ error: 'Drive not found.' }, { status: 404 });
  }
  return NextResponse.json({ scopes: (await listScopes(id)).map(toScopeDTO) });
}

const Body = z.object({
  scopes: z
    .array(
      z.object({
        itemId: z.string().min(1),
        path: z.string().min(1).startsWith('/'),
        isFolder: z.boolean(),
        name: z.string().nullish(),
      }),
    )
    .max(500, 'Too many selections — select parent folders instead.'),
});

/** Replace the drive's scope set. An empty array reverts to "sync everything".
 *  Saving clears the delta cursor so the next sync re-walks against the new
 *  scope (ingesting newly-in-scope files, pruning out-of-scope ones). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }
  const ok = await setDriveScopes(user.id, id, parsed.data.scopes);
  if (!ok) return NextResponse.json({ error: 'Drive not found.' }, { status: 404 });
  return NextResponse.json({ scopes: (await listScopes(id)).map(toScopeDTO) });
}
