import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { parseIntegrationMeta } from '@mantle/tools';
import { deleteToolGroup, getToolGroup, updateToolGroup } from '@/lib/tool-groups';
import { firstIssue } from '@/lib/zod-issue';

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
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { integration, ...rest } = parsed.data;

  // Connector groups (`integration.mcp` set) are managed by the connectors
  // API: their sync owns `toolSlugs`, and unbinding/rebinding here would
  // orphan mirrored tool rows and sealed OAuth state. Name/description/
  // enabled edits stay allowed. The mcp binding also can't be ATTACHED here —
  // POST /api/mcp-connectors is the one creation path.
  const current = await getToolGroup(user.id, idParsed.data.id);
  if (!current) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (current.integration?.mcp && (integration !== undefined || rest.toolSlugs !== undefined)) {
    return NextResponse.json(
      {
        error: `'${current.slug}' is an MCP connector group — its binding and membership are managed via /api/mcp-connectors/${current.slug.replace(/^mcp-/, '')} (Settings → Connectors); only name/description/enabled can change here`,
      },
      { status: 400 },
    );
  }
  if (current.integration?.openapi && (integration !== undefined || rest.toolSlugs !== undefined)) {
    return NextResponse.json(
      {
        error: `'${current.slug}' is an OpenAPI connector group — its binding and membership are managed via /api/openapi-connectors/${current.slug.replace(/^openapi-/, '')} (Settings → Connectors); only name/description/enabled can change here`,
      },
      { status: 400 },
    );
  }
  if (
    !current.integration?.mcp &&
    !current.integration?.openapi &&
    integration &&
    typeof integration === 'object' &&
    ('mcp' in integration || 'openapi' in integration)
  ) {
    return NextResponse.json(
      {
        error:
          'connectors are created via POST /api/mcp-connectors or POST /api/openapi-connectors, not by attaching a connector binding to an existing group',
      },
      { status: 400 },
    );
  }

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
