import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { TREE_FOLDER_NAME_MAX } from '@mantle/client-types/tree';
import { deleteMemberFolder, updateMemberFolder } from '@mantle/content/tree';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import { readJsonNoNul } from '@/lib/strip-nul';
import { firstIssue } from '@/lib/zod-issue';
import {
  FolderColorBody,
  FolderIconBody,
  memberTreeScope,
  readerTreeKindOr404,
  treeErrorResponse,
} from '@/lib/tree-route';

type Ctx = { params: Promise<{ kind: string; id: string }> };

const Id = z.string().uuid();
const Patch = z
  .object({
    name: z.string().trim().min(1).max(TREE_FOLDER_NAME_MAX),
    icon: FolderIconBody,
    color: FolderColorBody.nullable(),
    /** Move under a folder the member's tree shows; null = the top level. */
    parentId: z.string().uuid().nullable(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'nothing to change');

/** PATCH /api/member/tree/:kind/folders/:id : rename, restyle or move one of
 *  the member's own folders (folder plan phase 5); what it holds follows.
 *  Answers `{ folder }`. A brain folder, or anyone else's, is a 404. */
export async function PATCH(req: Request, ctx: Ctx) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const id = Id.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const parsed = Patch.safeParse(await readJsonNoNul(req));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const folder = await updateMemberFolder(memberTreeScope(member), kind, id.data, parsed.data);
    return NextResponse.json({ folder });
  } catch (err) {
    return treeErrorResponse(err);
  }
}

/** DELETE /api/member/tree/:kind/folders/:id : delete one of the member's own
 *  folders; its drafts and folders move up to its parent. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const id = Id.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  try {
    await deleteMemberFolder(memberTreeScope(member), kind, id.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return treeErrorResponse(err);
  }
}
