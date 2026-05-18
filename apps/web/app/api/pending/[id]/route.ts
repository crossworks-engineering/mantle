import { NextResponse } from 'next/server';
import { z } from 'zod';
import { approvePendingCall, getPendingCall, rejectPendingCall } from '@mantle/tools';
import { requireOwner } from '@/lib/auth';

const IdParams = z.object({ id: z.string().uuid() });
const PatchBody = z.object({ decision: z.enum(['approve', 'reject']) });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const row = await getPendingCall(user.id, idParsed.data.id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ pending: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'expected { decision: approve|reject }' }, { status: 400 });
  }
  try {
    const row =
      parsed.data.decision === 'approve'
        ? await approvePendingCall(user.id, idParsed.data.id)
        : await rejectPendingCall(user.id, idParsed.data.id);
    if (!row) {
      return NextResponse.json(
        { error: 'pending call not found or already decided' },
        { status: 404 },
      );
    }
    return NextResponse.json({ pending: row });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
