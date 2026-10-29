import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { cappedOne } from '@/lib/list-workspaces';
import { ownerCaller, ownerCallerAtRead } from '@/lib/auth';
import { hiddenFromKey } from '@/lib/api-v1';
import { deletePage, getPage, updatePage } from '@/lib/pages';
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
    caller: 'ownerAtRead',
    item: { param: 'id', need: 'edit' },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'manage' },
  },
});

const DocSchema = z.record(z.string(), z.unknown());

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  doc: DocSchema.optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  width: z.enum(['narrow', 'wide']).optional(),
  // Accepted and ignored. No client sends it (the editor saves drafts and
  // commits); a doc written here is indexed like a commit.
  reindex: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // A page made from an email attachment is not found for a key without
  // Search (access matrix T4).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = await getPage(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ page: await cappedOne(row) });
}

/**
 * The owner is read at the read (ownerCallerAtRead): PATCH
 * /api/v1/pages/:id runs this handler after it holds an API key to its
 * rules (route file of /api/v1/pages/:id), so the owner's answer, its item
 * check and its audit row, comes after those.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await ownerCallerAtRead();
  const { id } = await ctx.params;
  // An item made from an email attachment is not found for a key without
  // Search, its writes too (access matrix T4).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { reindex: _ignored, ...fields } = parsed.data;
  const row = await updatePage(user.id, id, fields);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ page: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // An item made from an email attachment is not found for a key without
  // Search, its writes too (access matrix T4).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const ok = await deletePage(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
