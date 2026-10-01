/**
 * GET /api/team-admin/submissions/:id/bundle : what Accept would move into
 * the brain (the item plus everything that renders inside it, the author's
 * own items only), how many links point at items that stay behind, and
 * `closure`: the brain items it embeds, at their current levels (the ones
 * above the chosen level go down with it; for a client's item at client or
 * public each needs a tick, audit A28), and `place`: where it lands by
 * default (the brain folder it was filed in, and the author's own folders
 * made below it, and the share it is read at there; folder plan phase 5).
 * `?folderId=` (a brain folder id, or `root`) works the place out for the
 * admin's pick instead. For the accept dialog.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { previewAccept } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { SubmissionParams, reviewErrorResponse, reviewNotFound } from '@/lib/member-review';

const Pick = z.union([z.literal('root'), z.string().uuid()]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const raw = new URL(req.url).searchParams.get('folderId');
  const pick = raw === null ? undefined : Pick.safeParse(raw);
  if (pick && !pick.success) return reviewNotFound();
  try {
    const bundle = await previewAccept(
      params.data.id,
      user.id,
      pick ? (pick.data === 'root' ? null : pick.data) : undefined,
    );
    return bundle ? NextResponse.json(bundle) : reviewNotFound();
  } catch (err) {
    return reviewErrorResponse(err);
  }
}
