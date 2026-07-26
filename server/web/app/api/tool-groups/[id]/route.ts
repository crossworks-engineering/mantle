import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { parseIntegrationMeta } from '@mantle/tools';
import { deleteToolGroup, getToolGroup, updateToolGroup } from '@/lib/tool-groups';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000),
    toolSlugs: z.array(z.string().min(1).max(120)).max(512),
    // The whole binding, or null to make it a plain capability bundle again.
    // Shape/scheme/secret-ref rules are enforced below by the same validator the
    // Toolsmith builtins use, so the owner path can't store something the
    // authoring path would refuse.
    integration: z.union([z.record(z.string(), z.unknown()), z.null()]),
    enabled: z.boolean(),
  })
  .partial();

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const group = await getToolGroup(user.id, idParsed.data.id);
  if (!group) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ group });
}

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
  const { integration, ...rest } = parsed.data;
  let integrationPatch: Parameters<typeof updateToolGroup>[2]['integration'];
  const warnings: string[] = [];
  if (integration !== undefined) {
    if (integration === null) {
      integrationPatch = null;
    } else {
      const meta = parseIntegrationMeta(integration);
      if (!meta.ok) return NextResponse.json({ error: meta.error }, { status: 400 });
      integrationPatch = meta.value;
      warnings.push(...meta.warnings);
    }
  }
  const row = await updateToolGroup(user.id, idParsed.data.id, {
    ...rest,
    ...(integration !== undefined ? { integration: integrationPatch } : {}),
  });
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ group: row, ...(warnings.length > 0 ? { warnings } : {}) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const ok = await deleteToolGroup(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
