import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { countPageDescendants } from '@/lib/pages';

/**
 * Number of nested pages under this one. Cheap pre-delete check so the UI can
 * warn that deleting a parent takes its whole subtree (parent_id is ON DELETE
 * CASCADE). Read-only; returns 0 for a leaf page.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const count = await countPageDescendants(user.id, id);
  return NextResponse.json({ count });
}
