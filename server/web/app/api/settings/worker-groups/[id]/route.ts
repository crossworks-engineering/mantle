import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  deleteWorkerGroup,
  getWorkerGroup,
  listEnabledWorkerAgents,
  updateWorkerGroup,
  validateWorkerGroupMembers,
  WORKER_GROUP_MAX_MEMBERS,
} from '@/lib/worker-groups';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    name: z.string().min(1).max(200),
    memberSlugs: z.array(z.string().min(1).max(64)).max(WORKER_GROUP_MAX_MEMBERS),
    enabled: z.boolean(),
  })
  .partial();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  // Member validation mirrors worker_group_ensure exactly (enabled workers,
  // 1..10). Only run it when members are being set.
  if (parsed.data.memberSlugs) {
    const enabled = new Set((await listEnabledWorkerAgents(user.id)).map((w) => w.slug));
    const err = validateWorkerGroupMembers(parsed.data.memberSlugs, enabled);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  const row = await updateWorkerGroup(user.id, idParsed.data.id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ group: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const group = await getWorkerGroup(user.id, idParsed.data.id);
  if (!group) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const ok = await deleteWorkerGroup(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
