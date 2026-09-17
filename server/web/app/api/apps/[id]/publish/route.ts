/**
 * /api/apps/[id]/publish — compile the draft and promote it to the live app.
 * This is the "Commit" action in the editor.
 *
 * It ALWAYS builds first. The published source and the published bundle have to
 * describe the same app, and the only way to guarantee that is to compile the
 * source we are about to publish rather than trust whatever artifact happens to
 * be staged. (Staged artifacts are invalidated on every source edit, so a stale
 * one can no longer be promoted — but committing from a fresh compile means the
 * two cannot diverge in the first place, rather than being caught after.)
 *
 * A failed compile fails the commit (422) and leaves the live app untouched.
 *
 * The MCP `app_publish` tool deliberately keeps the explicit build-then-publish
 * loop: agents want the compile errors as their own feedback step.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getApp, publishApp, NoGreenBuildError } from '@mantle/content';
import { runAppBuild } from '@/lib/app-build-run';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;

  const existing = await getApp(user.id, id);
  if (!existing) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  // Nothing staged — committing is a no-op, and building here would leave a
  // stray artifact behind for a draft that doesn't exist.
  if (!existing.draft) return NextResponse.json({ app: existing });

  const outcome = await runAppBuild(user.id, id);
  if (!outcome) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  if (!outcome.buildOk) {
    return NextResponse.json(
      { error: 'build failed', errors: outcome.errors, warnings: outcome.warnings },
      { status: 422 },
    );
  }

  try {
    const app = await publishApp(user.id, id);
    if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
    return NextResponse.json({ app });
  } catch (err) {
    if (err instanceof NoGreenBuildError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
