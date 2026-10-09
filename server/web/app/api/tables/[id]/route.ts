import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { hiddenFromKey } from '@/lib/api-v1';
import { deleteTable, getTable, updateTable } from '@/lib/tables';
import { firstIssue } from '@/lib/zod-issue';

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.enum(['private', 'public']).optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  // An email attachment's table is not found for a key without Search (T4).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const tabId = new URL(req.url).searchParams.get('tab') ?? undefined;
  const row = await getTable(user.id, id, tabId ? { tabId } : {}).catch((err) => {
    if (err instanceof Error && /no tab/.test(err.message)) return null;
    throw err;
  });
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ table: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  // An item made from an email attachment is not found for a key without
  // Search, its writes too (access matrix T4, audit B1).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await updateTable(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ table: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  // An item made from an email attachment is not found for a key without
  // Search, its writes too (access matrix T4, audit B1).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const ok = await deleteTable(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
