/**
 * PATCH /api/secrets/[id]  — update metadata and/or the sealed payload
 * DELETE /api/secrets/[id] — drop the node (cascades to `secrets` row)
 *
 * GET and PATCH answer the secret with the caller's caps (`mayEdit`,
 * `mayManage`, `mayMove`), as a note's item response (lib/list-workspaces).
 *
 * Reveal lives at /api/secrets/[id]/reveal so it audits separately.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { SECRET_KINDS, deleteSecret, getSecretMetadata, updateSecret } from '@/lib/secrets';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { cappedOne } from '@/lib/list-workspaces';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

/** A workspace kind since 0400: read where a grant reads it, edited with
 *  Write, deleted by a Moderator of its home, as for notes. */
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

const FieldSchema = z.object({
  label: z.string().max(80),
  value: z.string().max(8000),
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  kind: z.enum(SECRET_KINDS).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  note: z.string().max(50_000).optional(),
  fields: z.array(FieldSchema).max(32).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const row = await getSecretMetadata(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ secret: await cappedOne(row) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await updateSecret(user.id, id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ secret: await cappedOne(row) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await deleteSecret(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
