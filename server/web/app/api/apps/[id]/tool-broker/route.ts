/**
 * /api/apps/[id]/tool-broker — the host relays a running app's host.tools.call()
 * here. This is /api/dev-tools/execute-tool PLUS a per-app allowlist gate: the
 * slug MUST be declared in the app's manifest.toolSlugs, or we refuse. The tool
 * itself was authored by the toolsmith / API Console; we just dispatch it with
 * the owner's auth so secrets resolve server-side (the iframe never sees a key).
 *
 * The rules are those of the LOWER of the admin's level and the app's
 * (appToolLevel, client tier audit L1), the one rule the member and client
 * brokers share. An admin-level app runs any declared tool with the owner's
 * auth, as always. An app below admin keeps its level's rules even when an
 * admin runs it: its database is read by everyone at that level, so a tool
 * that read above it could copy team or admin data there. A team app gets
 * the member rules on the team role, a client app the client rules on the
 * client role (each on a surface that names the admin's login), a public
 * app no tools at all (its share link gets none).
 *
 * The id is bound to the authenticated session + route — an app can only ever
 * broker as itself.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { appToolLevel, appToolScope, appToolVerdict, dispatchTool } from '@mantle/tools';

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

  const level = appToolLevel('admin', app.audience);
  const verdict = await appToolVerdict(
    level,
    user.id,
    app.manifest.toolSlugs ?? [],
    parsed.data.slug,
  );
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }

  const scope = appToolScope(level, {
    loginId: user.actor.id,
    name: user.actor.displayName?.trim() || user.actor.email.split('@')[0] || 'admin',
  });
  const result = await withViewer(scope.viewer, () =>
    dispatchTool(verdict.tool, parsed.data.input, { ownerId: user.id, surface: scope.surface }),
  );
  return NextResponse.json(result);
}
