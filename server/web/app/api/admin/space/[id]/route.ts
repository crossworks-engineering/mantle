import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteMineItem, getMineItem, updateMineItem } from '@mantle/content';
import { adminWriter, getAdminSpaceOr401, inAdminSpace } from '@/lib/admin-space';
import { readJsonNoNul } from '@/lib/strip-nul';
import { SpaceIdParams, notFound, spaceStateResponse } from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

const Patch = z
  .object({
    title: z.string().trim().max(200).optional(),
    icon: z.string().max(16).optional(),
    /** A note's text. Notes save as they go (no draft). */
    content: z.string().max(200_000).optional(),
  })
  .strict();

/** A table's tab id; absent or unknown = the first tab. */
const Query = z.object({ tab: z.string().min(1).max(200).optional() });

/**
 * GET /api/admin/space/:id[?tab=] : one of the calling admin's own private
 * items with its body, drafts included, as GET /api/member/space/:id. A file
 * answers its metadata (the bytes are at /api/admin/space/:id/bytes).
 * PATCH { title?, icon?, content? } : rename, re-icon, or a note's text.
 * DELETE : remove it. Another login's item (another admin's included) is a
 * plain 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: 'Invalid tab.' }, { status: 400 });
  const tabId = query.data.tab;
  const got = await inAdminSpace(caller, () =>
    getMineItem(caller.spaceId, params.data.id, tabId ? { tabId } : {}),
  );
  return got ? NextResponse.json(got) : notFound();
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = Patch.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  try {
    const got = await inAdminSpace(caller, () =>
      updateMineItem(caller.spaceId, params.data.id, body.data, adminWriter(caller)),
    );
    return got ? NextResponse.json(got) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  try {
    const ok = await inAdminSpace(caller, () => deleteMineItem(caller.spaceId, params.data.id));
    return ok ? NextResponse.json({ ok: true }) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
