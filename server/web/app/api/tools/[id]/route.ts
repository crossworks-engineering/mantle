import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { handlerCarriesSecretRefs } from '@mantle/tools';
import { deleteTool, getToolById, keysAreaRefusal, toolMakerFor, updateTool } from '@/lib/tools';
import { ToolHandlerSchema } from '@/lib/tool-handler-schema';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'assistants' },
  PATCH: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
  DELETE: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
});

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
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const tool = await getToolById(user.id, idParsed.data.id);
  if (!tool) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ tool });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const raw = await readJson(req);
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
  // A refused edit (InputError, packages/tools crud.ts) answers 400 by the one
  // table (A10 part 2); a fault the opaque 500.
  const row = await updateTool(user.id, idParsed.data.id, {
    ...parsed.data,
    ...(handler ? { createdBy: toolMakerFor(user) } : {}),
  });
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ tool: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  // A refused delete (InputError) answers 400 by the one table (A10 part 2).
  const ok = await deleteTool(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
