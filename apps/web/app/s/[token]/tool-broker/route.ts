/**
 * POST /s/[token]/tool-broker — a SHARED app's host.tools.call(), brokered for
 * an unauthenticated viewer. The share token resolves to an active 'app' share;
 * the tool MUST be in the app's manifest.toolSlugs allowlist, and it runs under
 * the SHARE OWNER's scope (live data — secrets resolve server-side, the iframe
 * never sees them). This is the deliberate "live data, declared tools only"
 * model: anyone with the link can invoke the app's *declared* tools, so apps
 * shared this way must only declare read-only data tools.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveActiveShareByToken } from '@/lib/shares';
import { getApp } from '@mantle/content';
import { resolveTool, dispatchTool } from '@mantle/tools';

export const runtime = 'nodejs';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.unknown()).optional().default({}),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

  const app = await getApp(share.ownerId, share.nodeId);
  if (!app || !app.publishedBuild?.ok) {
    return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
  }

  const allowed = app.manifest.toolSlugs ?? [];
  if (!allowed.includes(parsed.data.slug)) {
    return NextResponse.json(
      { ok: false, error: `This shared app isn't allowed to use the tool '${parsed.data.slug}'.` },
      { status: 403 },
    );
  }

  const tool = await resolveTool(share.ownerId, parsed.data.slug);
  if (!tool) {
    return NextResponse.json({ ok: false, error: `tool '${parsed.data.slug}' not found` }, { status: 404 });
  }

  const result = await dispatchTool(tool, parsed.data.input, { ownerId: share.ownerId, surface: { kind: 'web' } });
  return NextResponse.json(result);
}
