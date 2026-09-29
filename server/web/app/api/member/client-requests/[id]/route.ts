import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withHumanViewer } from '@mantle/db';
import { getClientRequestItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid() });

/**
 * GET /api/member/client-requests/:id : one item a client submitted, with
 * its SAVED version (a page's published doc, a note's text, a file's
 * metadata; the bytes from ./bytes) and its author, the client. An item in a
 * submitted item's bundle reads too, so its embeds render. Read on the team
 * role with the human flag on; anything else (a client's draft, returned or
 * accepted item, a member's draft, a brain item) is a plain 404.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const got = await withHumanViewer('team', () => getClientRequestItem(params.data.id));
  if (!got) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json(got);
}
