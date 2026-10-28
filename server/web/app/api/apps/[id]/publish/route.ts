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
 *
 * Body (optional): `{ summary }`, the author's summary of the app (Journal v3
 * J9). Without one, one summarizer call writes it after a green build, unless
 * the code and manifest are the ones the kept summary was made from
 * (@mantle/tools publish-summary.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getApp, publishApp } from '@mantle/content';
import { z } from 'zod';
import { appPublishSummary, buildAndStageApp } from '@mantle/tools';
import { assertItemRight, PUBLISHED_SUMMARY_MAX_CHARS } from '@mantle/db';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts; the item gate answered it
 *  until the pre-check removal part 2). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'manage' },
  },
});

const PublishBody = z.object({
  summary: z.string().max(PUBLISHED_SUMMARY_MAX_CHARS).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;

  const existing = await getApp(user.id, id);
  if (!existing) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  // The caller's edit (the pre-check removal part 2: the HTTP gate asked
  // it), before the draft is looked at: a reader is refused (403
  // item-workspace), not told "nothing to publish".
  await assertItemRight(id, 'edit');
  // Nothing staged — committing is a no-op, and building here would leave a
  // stray artifact behind for a draft that doesn't exist.
  if (!existing.draft) return NextResponse.json({ app: existing });
  // The body after the item: a caller who may not edit it is told so first.
  const body = await readBody(req, PublishBody);

  const outcome = await buildAndStageApp(user.id, id);
  if (!outcome) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  if (!outcome.buildOk) {
    return NextResponse.json(
      { error: 'build failed', errors: outcome.errors, warnings: outcome.warnings },
      { status: 422 },
    );
  }

  // NoGreenBuildError answers 409 by the one table (A10 part 2).
  const app = await publishApp(user.id, id, {
    summary: await appPublishSummary(user.id, id, body.summary),
  });
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ app });
}
