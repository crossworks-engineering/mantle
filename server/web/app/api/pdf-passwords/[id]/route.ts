import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { deletePdfPassword } from '@mantle/content';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'area',
    area: 'keys',
    item: { none: 'manages the keys area: the Admin step checks it' },
  },
});

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await deletePdfPassword(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
