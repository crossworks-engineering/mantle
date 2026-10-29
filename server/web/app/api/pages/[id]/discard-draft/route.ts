import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { discardDraft } from '@/lib/pages';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). The item gate does not answer a bad id
 *  here. */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

/**
 * Throw away the working draft. Used by the AI-assist panel's "Discard
 * changes" button when the user rejects the Pages agent's proposed
 * edits — published `doc` + brain index are untouched. Idempotent: no
 * effect if there was no draft to begin with.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await discardDraft(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
