import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { discardDrawDraft } from '@/lib/draws';

/**
 * Throw away the working draft — published scene + brain index untouched.
 * Idempotent: no effect if there was no draft to begin with.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await discardDrawDraft(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
