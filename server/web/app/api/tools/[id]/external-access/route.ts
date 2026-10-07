import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { getToolById } from '@/lib/tools';
import { setToolExternalAccess } from '@mantle/tools';
import { firstIssue } from '@/lib/zod-issue';

const IdParams = z.object({ id: z.string().uuid() });

const Body = z.object({
  allow: z.boolean(),
  readOnlyConfirmed: z.boolean().optional(),
});

/**
 * PUT /api/tools/:id/external-access: an admin switches "External access" on or
 * off for one outside (mcp or http) tool (packages/tools/src/external-access.ts,
 * docs/member-logins.md). Admin logins only (getOwnerOr401). On needs
 * `readOnlyConfirmed: true`: the admin confirms the tool only reads, since
 * the brain cannot check it. The row records when and which admin; the audit
 * log gets a `tool.external_access.on` / `.off` row. Answers the tool as GET does.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const res = await setToolExternalAccess(user.id, idParsed.data.id, {
    allow: parsed.data.allow,
    readOnlyConfirmed: parsed.data.readOnlyConfirmed,
    by: { via: 'web', actorId: user.actor.id, actorEmail: user.actor.email },
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  const tool = await getToolById(user.id, idParsed.data.id);
  if (!tool) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ tool });
}
