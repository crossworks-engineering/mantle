/**
 * POST /s/[token]/tool-broker — a SHARED app's host.tools.call(), brokered for
 * an external viewer. The tool MUST be in the app's manifest.toolSlugs
 * allowlist and runs under the SHARE OWNER's scope (live data — secrets
 * resolve server-side, the iframe never sees them). Capability follows the
 * share's mode:
 *
 *   public — anonymous: additionally the tool must pass isPublicReadOnlyTool
 *            (builtin + non-mutating + not privacy-tier). This is ENFORCED,
 *            not advisory — a declared write tool 403s on a public link.
 *   team   — an identified team member (live visitor cookie, membership
 *            re-checked per request): any declared tool, writes included,
 *            every call stamped with their contactId in the app access log.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveActiveShareByToken } from '@/lib/shares';
import { getApp, recordAppAccess } from '@mantle/content';
import { resolveTool, dispatchTool, isPublicReadOnlyTool } from '@mantle/tools';
import { resolveShareVisitor } from '@/lib/team-gate';

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

  const visitor = await resolveShareVisitor(req.headers.get('cookie'), share);
  if (!visitor) {
    return NextResponse.json(
      { ok: false, error: 'team session required — enter your team token to use this app' },
      { status: 401 },
    );
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

  if (visitor.mode === 'public' && !isPublicReadOnlyTool(tool)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `The tool '${parsed.data.slug}' isn't available on a public link — ` +
          `only read-only data tools are. Share the app in team mode for full access.`,
      },
      { status: 403 },
    );
  }

  recordAppAccess({
    ownerId: share.ownerId,
    appNodeId: share.nodeId,
    shareId: share.id,
    contactId: visitor.contactId,
    kind: 'tool',
    detail: { slug: parsed.data.slug },
  });

  const result = await dispatchTool(tool, parsed.data.input, { ownerId: share.ownerId, surface: { kind: 'web' } });
  return NextResponse.json(result);
}
