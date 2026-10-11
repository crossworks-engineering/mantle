import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { handlerCarriesSecretRefs } from '@mantle/tools';
import { deleteTool, getToolById, keysAreaRefusal, toolMakerFor, updateTool } from '@/lib/tools';
import { ToolHandlerSchema } from '@/lib/tool-handler-schema';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
    inputSchema: z.record(z.string(), z.unknown()),
    handler: ToolHandlerSchema,
    requiresConfirm: z.boolean(),
    enabled: z.boolean(),
  })
  .partial();

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const tool = await getToolById(user.id, idParsed.data.id);
  if (!tool) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ tool });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  // New templates are the writer's (W7a fix round 3): one that sends a vault
  // key needs the keys area, and the tool's refs then resolve while the
  // writer holds it.
  const handler = parsed.data.handler;
  if (handler && handlerCarriesSecretRefs(handler)) {
    const refused = await keysAreaRefusal(user);
    if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  }
  try {
    const row = await updateTool(user.id, idParsed.data.id, {
      ...parsed.data,
      ...(handler ? { createdBy: toolMakerFor(user) } : {}),
    });
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ tool: row });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  try {
    const ok = await deleteTool(user.id, idParsed.data.id);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
