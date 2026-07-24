/**
 * /api/apps/[id]/tool-broker — the host relays a running app's host.tools.call()
 * here. This is /api/dev-tools/execute-tool PLUS a per-app allowlist gate: the
 * slug MUST be declared in the app's manifest.toolSlugs, or we refuse. The tool
 * itself was authored by the toolsmith / API Console; we just dispatch it with
 * the owner's auth so secrets resolve server-side (the iframe never sees a key).
 *
 * The id is bound to the authenticated session + route — an app can only ever
 * broker as itself.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { resolveTool, dispatchTool } from '@mantle/tools';


const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  const app = await getApp(user.id, id);
  if (!app) return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });

  const allowed = app.manifest.toolSlugs ?? [];
  if (!allowed.includes(parsed.data.slug)) {
    return NextResponse.json(
      {
        ok: false,
        error: `This app isn't allowed to use the tool '${parsed.data.slug}'. It must be declared in the app's tools before it can run.`,
      },
      { status: 403 },
    );
  }

  const tool = await resolveTool(user.id, parsed.data.slug);
  if (!tool) {
    return NextResponse.json(
      { ok: false, error: `tool '${parsed.data.slug}' not found` },
      { status: 404 },
    );
  }

  const result = await dispatchTool(tool, parsed.data.input, {
    ownerId: user.id,
    surface: { kind: 'web' },
  });
  return NextResponse.json(result);
}
