import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { deleteEvent, getEvent, updateEvent } from '@/lib/events';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
  PATCH: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'manage' },
  },
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  remindMinutesBefore: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30)
    .optional(),
  timezone: z.string().max(64).optional(),
  recur: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
  recurUntil: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const row = await getEvent(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ event: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await updateEvent(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ event: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await deleteEvent(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
