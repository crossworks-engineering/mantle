import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { moveMemberItems } from '@mantle/content/tree';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import { readJsonNoNul } from '@/lib/strip-nul';
import { firstIssue } from '@/lib/zod-issue';
import { memberTreeScope, readerTreeKindOr404, treeErrorResponse } from '@/lib/tree-route';

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  /** A folder the member's tree shows; null = the top level. */
  folderId: z.string().uuid().nullable(),
});

/** POST /api/member/tree/:kind/move : file the member's own drafts in a
 *  folder its tree shows (folder plan phase 5). Each moves on its own;
 *  `failed` lists the ones that could not (another's, or with an admin). */
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Body.safeParse(await readJsonNoNul(req));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    return NextResponse.json(
      await moveMemberItems(memberTreeScope(member), kind, parsed.data.ids, parsed.data.folderId),
    );
  } catch (err) {
    return treeErrorResponse(err);
  }
}
