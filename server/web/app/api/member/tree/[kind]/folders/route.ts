import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { TREE_FOLDER_NAME_MAX } from '@mantle/client-types/tree';
import { createMemberFolder } from '@mantle/content/tree';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import { readJsonNoNul } from '@/lib/strip-nul';
import { firstIssue } from '@/lib/zod-issue';
import { memberTreeScope, readerTreeKindOr404, treeErrorResponse } from '@/lib/tree-route';

const Body = z.object({
  /** A folder the member's tree shows; null = the top level. */
  parentId: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(TREE_FOLDER_NAME_MAX),
});

/** POST /api/member/tree/:kind/folders : create one of the member's own
 *  private folders under a folder its tree shows (folder plan phase 5);
 *  answers `{ folder }` (`own: true`). 404 for a folder it does not see, 409
 *  when its tree already shows a folder of that name there. */
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
    const folder = await createMemberFolder(memberTreeScope(member), kind, parsed.data);
    return NextResponse.json({ folder }, { status: 201 });
  } catch (err) {
    return treeErrorResponse(err);
  }
}
