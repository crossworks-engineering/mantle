import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deletePeer, setOutboundToken, setPeerEnabled } from '@mantle/content';

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  outboundToken: z.string().min(1).max(8192).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  let touched = false;
  if (parsed.data.enabled !== undefined) {
    const ok = await setPeerEnabled(user.id, id, parsed.data.enabled);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    touched = true;
  }
  if (parsed.data.outboundToken !== undefined) {
    const ok = await setOutboundToken(user.id, id, parsed.data.outboundToken);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    touched = true;
  }
  if (!touched) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deletePeer(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
