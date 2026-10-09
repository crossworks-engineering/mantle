/**
 * GET /api/team-admin/member-items[?kind=page|note|table|draw|file] :
 * "Shared by members" (workspace review pattern, Jason 2026-10-09): what
 * active members shared with the team, newest change first, for the item
 * kinds' workspace screens. Admin only. Read on the team role with the human
 * flag on, exactly as a member reads a teammate's shared items, so a private
 * item is never listed. Submitted items wait in /api/team-admin/submissions.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { SPACE_ITEM_KINDS, listMemberItemsShared } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

const Query = z.object({ kind: z.enum(SPACE_ITEM_KINDS).optional() });

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: 'Invalid kind.' }, { status: 400 });
  return NextResponse.json({ items: await listMemberItemsShared(user.actor.id, query.data.kind) });
}
