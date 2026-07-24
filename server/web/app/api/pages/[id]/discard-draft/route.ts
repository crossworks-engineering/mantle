import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { discardDraft } from '@/lib/pages';

/**
 * Throw away the working draft. Used by the AI-assist panel's "Discard
 * changes" button when the user rejects the Pages agent's proposed
 * edits — published `doc` + brain index are untouched. Idempotent: no
 * effect if there was no draft to begin with.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await discardDraft(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
