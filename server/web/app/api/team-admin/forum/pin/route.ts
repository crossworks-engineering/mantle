/**
 * Owner-only: pin/unpin a forum topic (the announcement mechanism — pinned
 * topics float to the top of every member's list). Session-gated (under
 * /api/team-admin, not in PUBLIC_PATHS).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { setForumTopicPinned } from '@mantle/content';

const Body = z.object({ topicId: z.string().uuid(), pinned: z.boolean() });

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const changed = await setForumTopicPinned(user.id, parsed.data.topicId, parsed.data.pinned);
  if (!changed) return NextResponse.json({ error: 'topic not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
