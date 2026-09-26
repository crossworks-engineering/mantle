import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteMineItem, getMineItem, updateMineItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { SpaceIdParams, inMySpace, notFound, spaceStateResponse } from '@/lib/member-space';
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
 * GET /api/member/space/:id[?tab=] : one of the member's own items with its
 * body, drafts included (their working copy), plus sharing and review state.
 * A table reads the chosen tab; a file answers its metadata (the bytes are at
 * /api/member/space/:id/bytes).
 * PATCH { title?, icon?, content? } : rename, re-icon, or a note's text.
 * DELETE : remove it. A submitted item is frozen: PATCH and DELETE answer
 * 409 `frozen` until the member recalls it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: 'Invalid tab.' }, { status: 400 });
  const tabId = query.data.tab;
  const got = await inMySpace(member, () =>
    getMineItem(member.spaceId, params.data.id, tabId ? { tabId } : {}),
  );
  return got ? NextResponse.json(got) : notFound();
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = Patch.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  try {
    const got = await inMySpace(member, () =>
      updateMineItem(member.spaceId, params.data.id, body.data),
    );
    return got ? NextResponse.json(got) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  try {
    const ok = await inMySpace(member, () => deleteMineItem(member.spaceId, params.data.id));
    return ok ? NextResponse.json({ ok: true }) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
