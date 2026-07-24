/**
 * POST /s/[token]/tool-broker — a SHARED app's host.tools.call(), brokered for
 * an external viewer. The tool MUST be in the app's manifest.toolSlugs
 * allowlist and runs under the SHARE OWNER's scope (live data — secrets
 * resolve server-side, the iframe never sees them). Capability follows the
 * share's mode:
 *
 *   public — anonymous: NO brain tools at all. Every read tool reaches the
 *            owner's private content (search_chunks returns raw email/journal
 *            passages, etc.), so a public app is confined to its own SQLite
 *            (query-only db-broker). isPublicToolAllowed() is the hard gate.
 *   team   — an identified team member (live visitor cookie, membership
 *            re-checked per request): any declared BUILTIN tool, writes
 *            included, every call stamped with their contactId. http/shell/
 *            recipe handlers are refused even here — a shared app must not be
 *            able to hand a contact server-side command exec or SSRF under the
 *            owner (and dispatchTool doesn't honor requiresConfirm, so a
 *            destructive builtin also runs un-gated — declaring one is the
 *            owner's explicit choice, but an arbitrary HTTP/shell call is not
 *            something we let a share expose).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveActiveShareByToken } from '@/lib/shares';
import { getApp, recordAppAccess } from '@mantle/content';
import { resolveTool, dispatchTool, isPublicToolAllowed } from '@mantle/tools';
import { resolveShareVisitorFromRequest } from '@/lib/team-gate';

export const runtime = 'nodejs';

const Body = z.object({
  slug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'app') {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  const visitor = await resolveShareVisitorFromRequest(req, share);
  if (!visitor) {
    return NextResponse.json(
      { ok: false, error: 'team session required — enter your team token to use this app' },
      { status: 401 },
    );
  }

  // Public shares get no brain tools, period — the read tools reach private
  // owner content by design, and there's no per-node visibility to scope to.
  if (visitor.mode === 'public' && !isPublicToolAllowed()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'This is a public link, which can only use the app’s own data. ' +
          'Share the app in team mode to let members use your Mantle tools.',
      },
      { status: 403 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: 'invalid input' }, { status: 400 });

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
    return NextResponse.json(
      { ok: false, error: `tool '${parsed.data.slug}' not found` },
      { status: 404 },
    );
  }

  // Even for an identified team member, a share never dispatches an http/shell/
  // recipe handler: those can reach arbitrary URLs / the shell / composed tools
  // under the owner. Shared apps may only drive BUILTIN tools.
  if (tool.handler.kind !== 'builtin') {
    return NextResponse.json(
      {
        ok: false,
        error: `The tool '${parsed.data.slug}' can't be used from a shared app (only built-in tools are available externally).`,
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

  const result = await dispatchTool(tool, parsed.data.input, {
    ownerId: share.ownerId,
    surface: { kind: 'web' },
  });
  return NextResponse.json(result);
}
