/**
 * Owner-only: dismiss a forum upload — the reject action of the review. The
 * quarantine bytes are deleted; the blob row stays as the audit record (the
 * member's chip renders "removed"). The queue must be drainable (decision).
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getForumUpload, markForumUploadDismissed } from '@mantle/content';
import { deleteQuarantineBytes } from '@mantle/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'upload not found' }, { status: 404 });

  const blob = await getForumUpload(user.id, id);
  if (!blob) return NextResponse.json({ error: 'upload not found' }, { status: 404 });
  if (blob.status !== 'pending') {
    return NextResponse.json(
      { error: `already ${blob.status} — refresh to see the current queue` },
      { status: 409 },
    );
  }

  const marked = await markForumUploadDismissed(user.id, id);
  if (!marked) {
    return NextResponse.json(
      { error: 'already reviewed — refresh to see the current queue' },
      { status: 409 },
    );
  }
  await deleteQuarantineBytes(user.id, id);
  return NextResponse.json({ ok: true });
}
