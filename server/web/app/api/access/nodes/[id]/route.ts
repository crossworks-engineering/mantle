/**
 * GET   /api/access/nodes/:id  -> the item's level and its closure (the
 *                                 embeds / folder contents its share needs).
 * PATCH /api/access/nodes/:id  { audience, withClosure? } -> set the level.
 *
 * Owner only. Member logins Phase 0b: the Access control's API. The rules
 * (type ceiling, closure lowered on request and never raised) live in
 * @mantle/content access.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { AccessError, accessClosure, setItemAudience } from '@mantle/content';
import { db, nodes, VIEWER_LEVELS } from '@mantle/db';

const IdParams = z.object({ id: z.string().uuid() });
const PatchBody = z.object({
  audience: z.enum(VIEWER_LEVELS),
  withClosure: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const [item] = await db
    .select({ id: nodes.id, type: nodes.type, title: nodes.title, audience: nodes.audience })
    .from(nodes)
    .where(and(eq(nodes.id, idParsed.data.id), eq(nodes.ownerId, user.id)))
    .limit(1);
  if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const closure = await accessClosure(user.id, item.id);
  return NextResponse.json({ item, closure });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'Invalid input.') },
      { status: 400 },
    );
  }
  try {
    const res = await setItemAudience(user.id, idParsed.data.id, parsed.data.audience, {
      withClosure: parsed.data.withClosure === true,
    });
    return NextResponse.json(res);
  } catch (err) {
    if (err instanceof AccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === 'not_found' ? 404 : 400 },
      );
    }
    throw err;
  }
}
