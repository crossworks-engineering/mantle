/**
 * Owner-only: post into a forum topic as the brain admin (an `owner` post —
 * no agent turn fires; the owner IS the answer). Optionally flips the topic's
 * status in the same call ("answer and mark answered"). Session-gated.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { appendForumPost, loadProfilePreferences, setForumTopicStatus } from '@mantle/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  topicId: z.string().uuid(),
  text: z.string().min(1).max(20_000),
  status: z.enum(['open', 'answered', 'closed']).optional(),
});

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
  const { topicId, text, status } = parsed.data;

  try {
    const prefs = await loadProfilePreferences(user.id);
    const post = await appendForumPost({
      ownerId: user.id,
      topicId,
      author: { kind: 'owner', name: prefs.displayName || 'Brain owner' },
      body: text,
    });
    if (status) await setForumTopicStatus(user.id, topicId, status);
    return NextResponse.json({ postId: post.id }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('topic not found')) {
      return NextResponse.json({ error: 'topic not found' }, { status: 404 });
    }
    console.error('[team-admin/forum/post]', msg);
    return NextResponse.json({ error: 'could not post' }, { status: 500 });
  }
}
