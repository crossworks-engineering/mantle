import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { cappedOne } from '@/lib/list-workspaces';
import { ownerCaller } from '@/lib/auth';
import { hiddenFromKey } from '@/lib/api-v1';
import { deleteNote, getNote, updateNote } from '@/lib/notes';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). The item gate does not answer a bad id
 *  here. */
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
  content: z.string().max(500_000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // A note made from an email attachment is not found for a key without
  // Search (access matrix T4).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = await getNote(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ note: await cappedOne(row) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // An item made from an email attachment is not found for a key without
  // Search, its writes too (access matrix T4, audit B1).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await updateNote(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ note: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // An item made from an email attachment is not found for a key without
  // Search, its writes too (access matrix T4, audit B1).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const ok = await deleteNote(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
