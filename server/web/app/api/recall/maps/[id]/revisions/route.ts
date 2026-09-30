import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getRecallRevisions } from '@/lib/recall';
import { UUID_RE } from '@mantle/std';

/** The revisions panel, newest first. Also the audit of AGENT edits, which
 *  matters because v2 serves an agent's card edit immediately. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ revisions: await getRecallRevisions(user.id, id) });
}
