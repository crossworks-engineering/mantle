import { NextResponse } from 'next/server';
import { getOwnedNode } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

/** One owner-scoped node's id + type — the type-blind resolver behind the
 *  `/n/<id>` permalink. 404 (not 403) for a leaked id so existence doesn't leak. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const node = await getOwnedNode(user.id, id);
  if (!node) return NextResponse.json({ error: 'Node not found.' }, { status: 404 });
  return NextResponse.json({ node });
}
